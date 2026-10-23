import assert from "node:assert/strict";
import { spawn as realSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  HELPER_PATH, PATH_EXPORT, UnsafeArgument, assertSafeArg, bindHelper, buildSkillsTar, describeOp, helperPath, opApply, opBackup, opCommit, opHelperVerify,
  opInspect, opInstallHelper, opPurge, opPutEnv, opReload, opRestore, opSkillsSync, opStageCheck, opVerify, validateHost, validateUser,
} from "../../packages/acceptance/ops.js";
import { RecordingTransport, SandboxTransport, SshTransport } from "../../packages/acceptance/transports.js";
import { sha256Hex, validateReceipt } from "../../packages/acceptance/receipt.js";
import { Transaction } from "../../packages/acceptance/transaction.js";
import { OperatorInputInvalid } from "../../packages/acceptance/untrusted.js";
import { cannedResponder } from "./helpers/canned.mjs";
import { assertGolden } from "./helpers/golden.mjs";
import { FAKE, FIXTURE_SKILLS, OPERATOR, SECRET_VALUES, contract, fingerprint, makeBlueprint, readAllReceiptText, scratchDir } from "./helpers/harness.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SCRIPT_PATH = path.join(here, "fixtures", "target-script-fixture.sh");
const FIXTURE_SCRIPT = readFileSync(FIXTURE_SCRIPT_PATH, "utf8");
const PINNED_HELPER = helperPath(sha256Hex(FIXTURE_SCRIPT));
const TXN = "accept000001";
const KEYS = contract.managed_env_keys;
const SCHEDULE = OPERATOR.schedule;
const SKILLS = contract.managed_skills;

function allOps() {
  const tar = buildSkillsTar(FIXTURE_SKILLS, SKILLS);
  return [
    opInspect(FIXTURE_SCRIPT),
    opInstallHelper(FIXTURE_SCRIPT),
    opHelperVerify(),
    opBackup({ txn: TXN, keys: KEYS }),
    ...KEYS.map((key) => opPutEnv({ txn: TXN, key, allow: KEYS, value: key === "TELEGRAM_HOME_CHANNEL" ? FAKE.chat : key === "GITHUB_TOKEN" ? FAKE.github : key === "TELEGRAM_BOT_TOKEN" ? FAKE.bot : FAKE.allowed })),
    opStageCheck({ txn: TXN }),
    opSkillsSync({ txn: TXN, names: SKILLS, tar }),
    opApply({ txn: TXN, cron: { id: contract.schedule.id, schedule: SCHEDULE, prompt: contract.schedule.prompt } }),
    opReload({ txn: TXN }),
    opVerify({ txn: TXN, destinationFp: fingerprint(FAKE.chat), allowVar: contract.destination.allow_var, destVar: contract.destination.env_key, cronId: contract.schedule.id, schedule: SCHEDULE, skills: SKILLS }),
    opRestore({ txn: TXN }),
    opCommit({ txn: TXN }),
    opPurge({ txn: TXN }),
  ].map((op) => bindHelper(op, sha256Hex(FIXTURE_SCRIPT)));
}

const SECRETS = [FAKE.github, FAKE.bot, FAKE.chat, FAKE.allowed];

test("golden SSH command fixtures for every op (UPDATE_GOLDEN=1 regenerates)", () => {
  const ops = allOps();
  assert.equal(new Set(ops.map((op) => op.op)).size, 13, "every op kind is covered");
  const text = ops.map((op) => {
    const described = describeOp(op);
    return [`== ${described.op} [${described.mutates}] ==`, `$ ${described.remote}`, `< ${described.stdin ?? "(no stdin)"}`].join("\n");
  }).join("\n\n");
  assertGolden("ops.txt", text);
});

test("secrets reach the target only on stdin: never in argv, never in the redacted description", () => {
  for (const op of allOps()) {
    for (const secret of SECRETS) {
      assert.equal(op.remote.includes(secret), false, `${op.op} remote contains a secret`);
      assert.equal(String(op.redactedStdin ?? "").includes(secret), false, `${op.op} redacted stdin contains a secret`);
      assert.equal(JSON.stringify(describeOp(op)).includes(secret), false);
    }
  }
  const put = opPutEnv({ txn: TXN, key: "GITHUB_TOKEN", allow: KEYS, value: FAKE.github });
  assert.equal(put.stdin, `${FAKE.github}\n`);
  assert.equal(put.redactedStdin, `<STDIN secret len=${FAKE.github.length}>`);
  assert.equal(put.mutates, "staging");
});

test("no op ever contains doctor, --fix, eval, restart or command substitution", () => {
  for (const op of allOps()) {
    for (const forbidden of ["doctor", "--fix", "eval ", "restart", "$(", "`", "&&&", "sudo", "curl", "wget", "rm -rf", " | sh", ">>"]) {
      if (op.op === "install-helper" && forbidden === "$(") continue; // fixed mktemp invocation only
      assert.equal(op.remote.includes(forbidden), false, `${op.op}: ${forbidden}`);
    }
  }
});

test("every target op carries the PATH export and calls the installed helper with only single-quoted arguments", () => {
  const target = allOps().filter((op) => op.remote.startsWith(PATH_EXPORT));
  assert.deepEqual(target.map((op) => op.op).sort(), ["apply", "backup", "commit", "put-env", "put-env", "put-env", "put-env", "purge", "reload", "restore", "stage-check", "skills-sync", "verify"].sort());
  for (const op of target) {
    assert.ok(op.remote.startsWith(`${PATH_EXPORT}${PINNED_HELPER} ${op.op}`), op.op);
    // After removing quoted arguments only the fixed skeleton and `--flag` words remain.
    const skeleton = op.remote.slice(PATH_EXPORT.length + PINNED_HELPER.length).replace(/'[^']*'/g, "ARG");
    assert.match(skeleton, /^ [a-z-]+( (ARG|--[a-z-]+))*$/, op.remote);
  }
  assert.equal(PATH_EXPORT, 'export PATH="$HOME/.local/bin:$PATH"; ');
  assert.equal(opInspect(FIXTURE_SCRIPT).remote, "bash -s -- inspect");
  assert.equal(opInspect(FIXTURE_SCRIPT).mutates, "none");
  const install = opInstallHelper(FIXTURE_SCRIPT);
  assert.ok(install.remote.includes(`ln "$t" ${PINNED_HELPER}`), "publish by no-clobber hard link");
  assert.equal(install.remote.includes(`cat > ${PINNED_HELPER}`), false, "never truncate a published helper");
  assert.equal(install.remote.includes(HELPER_PATH), false, "never install the shared legacy path");
});

test("only the live ops are marked live, and inspect/verify/stage-check mutate nothing", () => {
  const byOp = Object.fromEntries(allOps().map((op) => [op.op, op.mutates]));
  assert.deepEqual(byOp, {
    inspect: "none", "install-helper": "hstack-dir", "helper-verify": "none", backup: "hstack-dir", "put-env": "staging",
    "stage-check": "none", "skills-sync": "live", apply: "live", reload: "live", verify: "none", restore: "live", commit: "hstack-dir", purge: "hstack-dir",
  });
});

test("hostile arguments are rejected before any exec", async () => {
  const hostile = ["x;rm -rf /", "a b", "$(id)", "`id`", "a\nb", "a'b", "a\"b", "--fix", "../../etc", "a&b", "a>b", "", "x".repeat(600)];
  const recording = new RecordingTransport();
  for (const bad of hostile) {
    assert.throws(() => opBackup({ txn: bad, keys: KEYS }), UnsafeArgument, `txn ${JSON.stringify(bad).slice(0, 20)}`);
    assert.throws(() => opStageCheck({ txn: bad }), UnsafeArgument);
    assert.throws(() => opRestore({ txn: bad }), UnsafeArgument);
    assert.throws(() => opPutEnv({ txn: TXN, key: bad, allow: KEYS, value: "v" }), UnsafeArgument);
    assert.throws(() => opVerify({ txn: TXN, destinationFp: bad, allowVar: "A", destVar: "B", cronId: "c", schedule: "0 8 * * *" }), UnsafeArgument);
    assert.throws(() => opApply({ txn: TXN, cron: { id: bad, schedule: "0 8 * * *", prompt: "ok" } }), UnsafeArgument);
    assert.throws(() => assertSafeArg(bad), UnsafeArgument, "generic argument check");
  }
  assert.throws(() => opBackup({ txn: TXN, keys: ["lowercase"] }), UnsafeArgument);
  assert.throws(() => opBackup({ txn: TXN, keys: ["A;B"] }), UnsafeArgument);
  assert.throws(() => opBackup({ txn: TXN, keys: [] }), UnsafeArgument);
  assert.throws(() => opSkillsSync({ txn: TXN, names: ["Bad_Name"], tar: Buffer.from("x") }), UnsafeArgument);
  assert.throws(() => opSkillsSync({ txn: TXN, names: ["ok"], tar: Buffer.alloc(0) }), UnsafeArgument);
  assert.throws(() => opApply({ txn: TXN, cron: { id: "ok", schedule: "0 8 * * *; ls", prompt: "ok" } }), UnsafeArgument);
  assert.throws(() => opApply({ txn: TXN, cron: { id: "ok", schedule: "0 8 * * *", prompt: "it's" } }), UnsafeArgument);
  assert.throws(() => opApply({ txn: TXN, cron: { id: "ok", schedule: "0 8 * * *", prompt: "a|b" } }), UnsafeArgument);
  assert.throws(() => opApply({ txn: TXN, cron: { id: "ok", schedule: "0 8 * * *", prompt: "$(id)" } }), UnsafeArgument);
  assert.throws(() => opPutEnv({ txn: TXN, key: "GITHUB_TOKEN", allow: ["OTHER"], value: "v" }), UnsafeArgument, "key must be in the allow list");
  for (const value of ["", "has space", "new\nline", "quote'", "semi;colon", "$(id)", "a".repeat(4097)]) {
    const error = (() => { try { opPutEnv({ txn: TXN, key: "GITHUB_TOKEN", allow: KEYS, value }); } catch (e) { return e; } return null; })();
    assert.ok(error instanceof UnsafeArgument, JSON.stringify(value).slice(0, 20));
    assert.equal(error.message.includes(value) && value.length > 0, false, "errors never echo the value");
  }
  assert.equal(recording.calls.length, 0);
  // Space is allowed only where explicitly requested (cron spec / schedule).
  assert.throws(() => assertSafeArg("a b"), UnsafeArgument);
  assert.doesNotThrow(() => assertSafeArg("a b", { allowSpace: true }));
});

test("hostile host or user is rejected before any process is spawned; valid ones run exactly `ssh -o BatchMode=yes user@host '<remote>'`", async () => {
  const spawned = [];
  const spawnImpl = (...args) => { spawned.push(args); throw new Error("spawn must not be reached"); };
  const badHosts = ["-oProxyCommand=evil", "a b", "host;ls", "host$(id)", "x@y", "", "host\n", "-host", "fe80::1%eth0", "a_b.example", "host..example", "a".repeat(300), ".leading", "trailing-", "ho st"];
  for (const host of badHosts) {
    assert.throws(() => validateHost(host), UnsafeArgument, JSON.stringify(host).slice(0, 20));
    assert.throws(() => new SshTransport({ host, user: "root", spawnImpl }), UnsafeArgument);
  }
  const badUsers = ["-oFoo", "a b", "root;id", "a@b", "", "$(id)", "root\n", "x".repeat(40), "a`b`"];
  for (const user of badUsers) {
    assert.throws(() => validateUser(user), UnsafeArgument, JSON.stringify(user).slice(0, 20));
    assert.throws(() => new SshTransport({ host: "vps.example.com", user, spawnImpl }), UnsafeArgument);
  }
  for (const host of ["vps.example.com", "vps", "10.0.0.5", "::1", "2001:db8::1", "a-b.c-d.example.org"]) assert.equal(validateHost(host), host);
  for (const user of ["root", "deploy", "ubuntu-1", "a.b_c"]) assert.equal(validateUser(user), user);

  assert.equal(spawned.length, 0);
  const calls = [];
  const fakeSpawn = (command, args) => {
    calls.push([command, args]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => setImmediate(() => child.emit("close", 0));
    child.kill = () => {};
    return child;
  };
  const ssh = new SshTransport({ host: "vps.example.com", user: "root", spawnImpl: fakeSpawn });
  const op = opStageCheck({ txn: TXN });
  assert.deepEqual(ssh.argvFor(op), ["-o", "BatchMode=yes", "root@vps.example.com", op.remote]);
  const result = await ssh.exec(op);
  assert.equal(result.code, 0);
  assert.deepEqual(calls, [["ssh", ["-o", "BatchMode=yes", "root@vps.example.com", op.remote]]]);
  assert.equal(calls[0][1].length, 4, "the remote string is exactly ONE argument");
  assert.ok(!calls[0][1].some((arg) => arg === "StrictHostKeyChecking=accept-new"), "host key policy is the operator's ssh config");
});

test("ssh exit 255 is a transport failure (unknown outcome), not a command failure", async () => {
  const ssh = new SshTransport({
    host: "vps.example.com", user: "root", sshCommand: process.execPath,
    spawnImpl: (command, args, options) => realSpawn(command, ["-e", "process.exit(255)"], options),
  });
  const result = await ssh.exec(opStageCheck({ txn: TXN }));
  assert.equal(result.code, 255);
  assert.equal(result.transportError, true);
});
test("the sandbox runs the SAME remote string under env -i with only HOME and PATH", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "hstack-sbx-"));
  try {
    const transport = new SandboxTransport({ home, extraEnv: { HSTACK_STUB_LOG: path.join(home, "log") } });
    const op = { op: "probe", remote: "printenv | LC_ALL=C sort", stdin: null, redactedStdin: null, mutates: "none" };
    assert.deepEqual(transport.argvFor(op).slice(0, 4), ["-i", `HOME=${home}`, "PATH=/usr/bin:/bin", `HSTACK_STUB_LOG=${path.join(home, "log")}`]);
    assert.deepEqual(transport.argvFor(op).slice(-3), ["bash", "-c", op.remote]);
    const result = await transport.exec(op);
    const names = result.stdout.split("\n").filter(Boolean).map((line) => line.split("=")[0]);
    for (const name of names) assert.ok(["HOME", "PATH", "HSTACK_STUB_LOG", "PWD", "SHLVL", "_", "OLDPWD"].includes(name), `leaked env var ${name}`);
    assert.match(result.stdout, new RegExp(`^HOME=${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    assert.match(result.stdout, /^PATH=\/usr\/bin:\/bin$/m);
    // stdin passes through untouched
    const echo = await transport.exec({ op: "probe", remote: "cat", stdin: "hello stdin\n", redactedStdin: "<x>", mutates: "none" });
    assert.equal(echo.stdout, "hello stdin\n");
    assert.throws(() => new SandboxTransport({ home: "relative/path" }), UnsafeArgument);
    assert.throws(() => new SandboxTransport({ home: "/" }), UnsafeArgument);
    assert.throws(() => new SandboxTransport({ home: path.join(home, "missing") }), UnsafeArgument);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("hostile operator input is rejected by the Transaction constructor before any transport call", () => {
  const recording = new RecordingTransport();
  const dir = scratchDir("hstack-ops-");
  try {
    for (const operator of [
      { chatId: "1; touch /tmp/x", schedule: SCHEDULE }, { chatId: FAKE.chat, schedule: "$(id)" }, { chatId: "$(id)", schedule: SCHEDULE },
      { chatId: FAKE.chat, schedule: "0 8 * * *\nrm" }, { chatId: "--fix", schedule: SCHEDULE },
    ]) {
      assert.throws(() => new Transaction({ blueprint: makeBlueprint(), contract, operator, transport: recording, receiptDir: dir }), OperatorInputInvalid);
    }
    assert.throws(() => new Transaction({ blueprint: makeBlueprint(), contract, operator: OPERATOR, transport: recording, receiptDir: dir, txnId: "x;rm -rf" }), TypeError);
    assert.equal(recording.calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the deterministic skills archive is a valid ustar with sorted members and fixed metadata", () => {
  const tar = buildSkillsTar(FIXTURE_SKILLS, SKILLS);
  assert.equal(tar.length % 512, 0);
  assert.deepEqual(buildSkillsTar(FIXTURE_SKILLS, SKILLS), tar, "byte-identical on every call");
  const names = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    names.push(header.subarray(0, 100).toString("ascii").replace(/\0+$/, ""));
    assert.equal(header.subarray(257, 262).toString("ascii"), "ustar");
    assert.equal(parseInt(header.subarray(136, 147).toString("ascii"), 8), 0, "mtime pinned to 0");
    const size = parseInt(header.subarray(124, 135).toString("ascii"), 8);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.deepEqual(names, SKILLS.flatMap((name) => [`${name}/`, `${name}/SKILL.md`]));
  assert.throws(() => buildSkillsTar(FIXTURE_SKILLS, ["does-not-exist"]), UnsafeArgument);
  assert.throws(() => buildSkillsTar(FIXTURE_SKILLS, ["../escape"]), UnsafeArgument);
});

// ---- golden transcripts of whole transactions on a recording transport -----------------------

async function runRecorded({ finish }) {
  const dir = scratchDir("hstack-golden-");
  try {
    const recording = new RecordingTransport({ respond: cannedResponder({ scriptBody: FIXTURE_SCRIPT, txn: TXN }) });
    const tx = new Transaction({
      blueprint: makeBlueprint(), contract, operator: OPERATOR, transport: recording, receiptDir: dir, txnId: TXN,
      skillsRoot: FIXTURE_SKILLS, scriptPath: FIXTURE_SCRIPT_PATH,
      observer: { delivery: async ({ destinationFp }) => ({ deliveries: [{ to_fp: destinationFp, body_has_secret: false }] }) },
    });
    assert.equal((await tx.validate()).ok, true);
    assert.equal((await tx.inspect()).ok, true);
    await tx.reviewChanges((review) => review.plan_hash);
    assert.equal((await tx.stage(SECRET_VALUES)).ok, true);
    assert.equal((await tx.apply()).ok, true);
    await finish(tx);
    const result = validateReceipt(tx.receipt, { requiredChecks: contract.required_checks });
    assert.deepEqual(result.errors, [], "the receipt of a recorded run validates");
    const written = readAllReceiptText(dir);
    for (const secret of SECRETS) assert.equal(written.includes(secret), false, "no synthetic secret in any receipt or evidence file");
    assert.equal(tx.receipt.target_profile.transport_used, "recording");
    return { transcript: recording.transcript(), state: tx.state };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("golden command sequence: happy path validate -> verified", async () => {
  const { transcript, state } = await runRecorded({ finish: (tx) => tx.verify() });
  assert.equal(state, "verified");
  for (const secret of SECRETS) assert.equal(transcript.includes(secret), false);
  assert.equal(/doctor|--fix/.test(transcript), false);
  assertGolden("happy-path.txt", transcript);
});

test("golden command sequence: apply then rollback", async () => {
  const { transcript, state } = await runRecorded({ finish: (tx) => tx.rollback() });
  assert.equal(state, "restored_verified");
  for (const secret of SECRETS) assert.equal(transcript.includes(secret), false);
  assertGolden("rollback-path.txt", transcript);
});

test("the recording transport records redacted stdin only, never the real stdin", async () => {
  const recording = new RecordingTransport();
  await recording.exec(opPutEnv({ txn: TXN, key: "GITHUB_TOKEN", allow: KEYS, value: FAKE.github }));
  assert.equal(JSON.stringify(recording.calls).includes(FAKE.github), false);
  assert.equal(recording.calls[0].stdin, `<STDIN secret len=${FAKE.github.length}>`);
});
