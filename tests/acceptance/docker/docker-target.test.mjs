// Gated tests against a LOCAL DOCKER "VPS": a container running a real sshd, driven over the real `ssh`
// binary by (a) the hstack acceptance transaction through the shipped SshTransport and (b) the real fenced bash
// blocks of skills/platform-telegram/SKILL.md.
//
// What this adds over tests/acceptance/*.test.mjs (sandbox): a real ssh channel, real sshd environment and PATH
// rules (non-login, non-interactive: ~/.local/bin is NOT on PATH), a non-root user, and process argv that a
// `ps` on the target could see.
// What it does NOT prove: anything about real Hermes (the `hermes` here is the bash test double), a real
// Telegram or GitHub (curl is a test double and the container resolves those hosts to 127.0.0.1), systemd /
// service lifecycle, or a real VPS.
//
// Run:  HSTACK_DOCKER=1 node --test tests/acceptance/docker/
// Without HSTACK_DOCKER=1 (or without a Docker daemon) every test is registered as SKIPPED with a reason.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { validateReceipt } from "../../../packages/acceptance/receipt.js";
import { Transaction } from "../../../packages/acceptance/transaction.js";
import {
  FAKE, FIXTURE_SKILLS, OPERATOR, SCRIPT_SKIP, SECRET_VALUES, assertReceiptClean, contract, driveToApplied, makeBlueprint, newTransaction,
} from "../helpers/harness.mjs";
import {
  DOCKER_DIR, PATH_EXPORT, REPO, SSH_HOST, SSH_USER, dockerGate, getTarget, sha256, stopTarget,
} from "./helpers/docker-target.mjs";

const GATE = dockerGate(); // false | "skipped: <reason>"
const TX_GATE = GATE || SCRIPT_SKIP;
const gated = (name, fn, { skip = GATE, timeout = 15 * 60_000 } = {}) =>
  test(name, { skip, timeout }, async () => {
    const target = await getTarget();
    await fn(target);
  });

after(async () => { await stopTarget(); });

const check = (receipt, id) => receipt.checks.find((c) => c.id === id);
const PIN = /^HERMES_VERSION=(.+)$/m.exec(readFileSync(path.join(REPO, "VERSIONS.txt"), "utf8"))[1].trim();
const ENV_KEYS = ["GITHUB_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS"];

// ===============================================================================================
// 1. the target itself
// ===============================================================================================

gated("target: real sshd reachable through the ssh wrapper; loopback-only, key-only, non-root", async (t) => {
  const r = await t.ssh('echo ok; id -un; id -u; echo "$HOME"');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["ok", SSH_USER, "2000", "/home/operator"]);
  assert.ok(t.wrapperCalls().length >= 1, "the call really went through the ssh wrapper");

  const published = t.dockerPort().split("\n").filter(Boolean);
  assert.ok(published.length >= 1 && published.every((line) => line.startsWith("127.0.0.1:")), `published only on loopback: ${published}`);

  const cfg = t.dockerExec(["/usr/sbin/sshd", "-T", "-f", "/etc/ssh/sshd_config"]).stdout;
  assert.match(cfg, /^passwordauthentication no$/m);
  assert.match(cfg, /^kbdinteractiveauthentication no$/m);
  assert.match(cfg, /^authenticationmethods publickey$/m);
  assert.match(cfg, /^permitrootlogin no$/m);

  // a password attempt cannot succeed (BatchMode: ssh exits 255 instead of prompting)
  const pw = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no", `${SSH_USER}@${SSH_HOST}`, "true"],
    { env: t.childEnv(), encoding: "utf8", timeout: 30_000 });
  assert.equal(pw.status, 255, "password authentication is not available");
});

gated("target: a plain non-login `ssh host hermes --version` FAILS; the ~/.local/bin PATH prefix makes it work", async (t) => {
  // negative control: exactly what a skill/transaction that forgets the PATH export would hit on a real VPS
  const bare = await t.ssh("hermes --version");
  assert.equal(bare.code, 127, `expected 'command not found' (127), got ${bare.code}: ${bare.stdout}${bare.stderr}`);
  assert.match(bare.stderr, /hermes: (command )?not found/);
  assert.notEqual((await t.ssh("command -v hermes")).code, 0);
  assert.equal((await t.ssh('echo "$PATH"')).stdout.includes(".local/bin"), false, "~/.local/bin is not on the non-login PATH");
  const outside = await t.ssh("test ! -e /usr/bin/hermes && test ! -e /usr/local/bin/hermes && test ! -e /bin/hermes && echo absent");
  assert.equal(outside.stdout.trim(), "absent", "hermes is installed ONLY under ~/.local/bin");

  // positive control: the prefix the skills and the transaction use
  const withPath = await t.ssh(`${PATH_EXPORT}hermes --version`);
  assert.equal(withPath.code, 0, withPath.stderr);
  assert.equal(withPath.stdout.trim(), `hermes ${PIN}`, "the stub prints the pin declared in VERSIONS.txt");
});

gated("target: the wrapper leaves the shipped SshTransport argv untouched (host operator@127.0.0.1)", async (t) => {
  const transport = t.transport();
  const op = { op: "probe", remote: 'echo "wrapped:$(id -un)"', stdin: null, redactedStdin: null, mutates: "none" };
  assert.deepEqual(transport.argvFor(op), ["-o", "BatchMode=yes", `${SSH_USER}@${SSH_HOST}`, op.remote]);
  t.clearWrapperLog();
  const result = await transport.exec(op);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.transportError, false);
  assert.equal(result.stdout.trim(), "wrapped:operator");
  assert.deepEqual(t.wrapperCalls(), [transport.argvFor(op).join(" ")], "the wrapper received exactly the shipped argv, nothing added");
});

gated("target: the /proc argv sampler really sees a secret placed in a process argument (positive control)", async (t) => {
  const canary = `CANARY-${sha256("canary").slice(0, 12)}`;
  const sampler = await t.startArgvSampler();
  const r = await t.ssh(`bash -c 'sleep 1.5' ${canary}`);
  assert.equal(r.code, 0, r.stderr);
  const seen = await sampler.stop();
  assert.ok(seen.includes(canary), "a secret in argv IS visible to the sampler, so its absence below is meaningful");
});

// ===============================================================================================
// 2. the acceptance transaction through SshTransport against the container
// ===============================================================================================

gated("transaction: inspect is read-only; stage..verify over real ssh reaches verified; no secret in any argv", async (t) => {
  await t.reset();
  await t.setFixture("Issue 7: update the README");
  const hermesBefore = await t.treeHash('"$HOME/.hermes"');
  const homeBefore = await t.homeHash();
  const sampler = await t.startArgvSampler();

  const tx = newTransaction(t, { observer: t.observer({ secret: FAKE.vulnerableLeak }) });
  assert.equal((await tx.validate()).ok, true);
  const inspected = await tx.inspect();
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  assert.equal(await t.treeHash('"$HOME/.hermes"'), hermesBefore, "inspect left ~/.hermes byte-identical");
  assert.equal(await t.homeHash(), homeBefore, "inspect left the whole home directory byte-identical");
  assert.ok(
    t.wrapperCalls().some((c) => c === `-o BatchMode=yes ${SSH_USER}@${SSH_HOST} bash -s -- inspect`),
    "the inspect script travelled on stdin via `bash -s -- inspect`",
  );
  assert.equal(tx.inspection.os, "linux");

  await tx.reviewChanges((review) => review.plan_hash);
  const staged = await tx.stage(SECRET_VALUES);
  assert.equal(staged.ok, true, JSON.stringify(staged));
  const applied = await tx.apply();
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const outcome = await tx.verify();
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(tx.state, "verified");
  const sampled = await sampler.stop();

  // receipt: valid, secret-free, and honest about the transport
  const receipt = assertReceiptClean(assert, t, tx);
  assert.equal(validateReceipt(receipt, { requiredChecks: contract.required_checks }).valid, true);
  assert.equal(receipt.target_profile.transport_used, "ssh");
  assert.equal(receipt.target_profile.observed_os, "linux");
  assert.equal(check(receipt, "private-destination-delivery").status, "pass");
  assert.equal(check(receipt, "private-destination-delivery").scope, "delivery-observer");
  assert.equal(JSON.stringify(receipt).includes(FAKE.chat), false, "the raw chat id is never in a receipt");

  // the helper really ran on the target through ssh, and the stub's outbox (the Telegram double) got ONE message
  const reviewedHelper = `hstack-target-${receipt.artifacts.script_sha256}.sh`;
  assert.ok(t.wrapperCalls().some((c) => c.includes(`${reviewedHelper} put-env`)), "put-env ran through ssh using the reviewed helper");
  assert.ok(sampled.includes(reviewedHelper), "the sampler observed the transaction's reviewed target-side helper");
  const outbox = await t.outboxLines();
  assert.equal(outbox.length, 1);
  assert.match(outbox[0], new RegExp(`^to=${FAKE.chat} `));

  // secrets: nowhere in any ssh argv on the host, nowhere in any process argv on the target, nowhere in the stub log
  const secrets = [FAKE.github, FAKE.bot, FAKE.allowed];
  const hostArgv = t.wrapperCalls().join("\n");
  const stubLog = await t.stubLog();
  for (const secret of secrets) {
    assert.equal(hostArgv.includes(secret), false, "a secret appeared in a host-side ssh argument");
    assert.equal(sampled.includes(secret), false, "a secret appeared in a process argv visible to ps on the target");
    assert.equal(stubLog.includes(secret), false, "a secret appeared in a hermes argv");
  }
  assert.equal(/\bdoctor\b|--fix|\tconfig\tset\b|^config\tset\b/m.test(stubLog), false, "no doctor / --fix / `config set` (which would put values in argv)");

  // the secrets landed where intended: the live .env (mode 600) and hstack's private state, nowhere else
  const env = await t.envText();
  for (const key of ENV_KEYS) assert.match(env, new RegExp(`^${key}=.+$`, "m"), `${key} present`);
  assert.match(env, /^TELEGRAM_HOME_CHANNEL=555000111$/m);
  assert.match(env, /^UNRELATED_SETTING=keep-me$/m);
  assert.equal((await t.ssh('stat -c %a "$HOME/.hermes/.env"')).stdout.trim(), "600");
  const holders = (await t.ssh(`grep -rlF -e '${FAKE.bot}' -e '${FAKE.github}' "$HOME" 2>/dev/null | sed "s#^$HOME/##" | sort`)).stdout.split("\n").filter(Boolean);
  assert.ok(holders.includes(".hermes/.env"));
  assert.deepEqual(holders.filter((f) => f !== ".hermes/.env" && !f.startsWith(".hermes/.hstack/")), [], `secrets leaked outside .env and .hstack: ${holders}`);
  assert.equal((await t.ssh('grep -c . "$HOME/.hermes/config.yaml"')).stdout.trim(), "2", "config.yaml untouched (no secrets in it)");

  // marker mechanism: the acceptance flow writes `.hstack-acceptance` and NEVER the other pipeline's `.hstack-managed`
  assert.equal((await t.ssh('find "$HOME/.hermes" -name ".hstack-managed" | wc -l')).stdout.trim(), "0", "no .hstack-managed file or dir anywhere");
  assert.equal((await t.ssh('test -f "$HOME/.hermes/skills/platform-telegram/.hstack-acceptance" && echo yes')).stdout.trim(), "yes");
  assert.equal((await t.ssh('find "$HOME/.hermes/.hstack" -name "env.staged" | wc -l')).stdout.trim(), "0", "the staged copy of the new secrets was deleted after apply");
  assert.equal((await t.ssh('stat -c %a "$HOME/.hermes/.hstack"/txn/*/env.bak 2>/dev/null; true')).stdout.trim().split("\n").every((m) => m === "600" || m === ""), true);

  // unrelated user state untouched
  assert.equal((await t.cat('"$HOME/.hermes/skills/my-own-skill/SKILL.md"')), "# my own skill\nuser content\n");
  assert.equal((await t.managedCronLines()).length, 1);
  assert.match(await t.cronText(), /^job-0\t30 2 \* \* \*\tunrelated nightly job$/m);
});

/** A transport whose failure knob can be switched off between apply and rollback (the fault is transient). */
function switchableTransport(t, knob) {
  const failing = t.transport({ env: { HSTACK_STUB_FAIL: knob } });
  const healthy = t.transport();
  const state = { fail: true };
  return { kind: "ssh", exec: (op) => (state.fail ? failing : healthy).exec(op), state };
}

async function applyWithFailure(t, transport) {
  await t.reset({ priorBot: FAKE.botOld });
  const before = {
    envSha: await t.fileSha('"$HOME/.hermes/.env"'),
    state: await t.userStateHash(),
    skillSha: await t.fileSha('"$HOME/.hermes/skills/my-own-skill/SKILL.md"'),
    cron: await t.cronText(),
  };
  assert.match(await t.envText(), new RegExp(`^TELEGRAM_BOT_TOKEN=${FAKE.botOld}$`, "m"), "premise: a previous secret value is present");
  const { tx, applied } = await driveToApplied(t, { transport });
  assert.equal(applied.ok, false, "the connector step failed");
  assert.equal(tx.state, "rollback_required");
  assert.equal(check(tx.receipt, "apply").status, "fail");
  assert.notEqual(await t.userStateHash(), before.state, "premise: the failure left the target partially changed");
  assert.match(await t.envText(), new RegExp(`^TELEGRAM_BOT_TOKEN=${FAKE.bot}$`, "m"), "premise: the new secret had already been swapped in");
  return { tx, before };
}

/** The user's files are back exactly as before (sha256 computed in the container) whatever the gateway did. */
async function assertFilesRestored(t, before) {
  assert.equal(await t.fileSha('"$HOME/.hermes/.env"'), before.envSha, "previous secret restored byte for byte");
  assert.equal(await t.userStateHash(), before.state, "everything the user owned is exactly as before");
  assert.equal(await t.fileSha('"$HOME/.hermes/skills/my-own-skill/SKILL.md"'), before.skillSha);
  assert.equal((await t.ssh('test ! -e "$HOME/.hermes/skills/platform-telegram" && echo gone')).stdout.trim(), "gone");
  assert.equal((await t.managedCronLines()).length, 0);
  assert.equal(await t.cronText(), before.cron, "the unrelated cron entry is untouched");
  assert.equal((await t.ssh('find "$HOME/.hermes" -name ".hstack-managed" | wc -l')).stdout.trim(), "0");
  assert.equal((await t.ssh('find "$HOME/.hermes/.hstack" -name "env.staged" | wc -l')).stdout.trim(), "0", "no staged copy of the new secrets remains");
}

async function assertRestoredVerified(t, tx, before) {
  assert.equal(tx.state, "restored_verified");
  await assertFilesRestored(t, before);
  const receipt = assertReceiptClean(assert, t, tx);
  assert.equal(receipt.recovery.restoration_verified, true);
  assert.equal(check(receipt, "restoration").status, "pass");
  assert.equal(check(receipt, "gateway-reloaded").status, "pass", "restored_verified needs the gateway reload check");
  assert.equal(receipt.target_profile.transport_used, "ssh");
  assert.deepEqual(receipt.transitions.map((x) => x.to).slice(-3), ["applied_unverified", "rollback_required", "restored_verified"]);
  return receipt;
}

gated("transaction: forced cron failure after apply => rollback_required => restored_verified (incl. gateway-reloaded), prior secret back byte-for-byte", async (t) => {
  const { tx, before } = await applyWithFailure(t, t.transport({ env: { HSTACK_STUB_FAIL: "cron-create" } }));
  const rolled = await tx.rollback();
  assert.equal(rolled.ok, true, JSON.stringify(rolled));
  await assertRestoredVerified(t, tx, before);
  assert.equal((await t.cat('"$HOME/.hermes/gateway.state"')).trim(), "running", "the gateway was reloaded after the restore");
}, { skip: TX_GATE });

gated("transaction: gateway fault during apply, healthy at rollback => restored_verified with a reload recorded after the restore", async (t) => {
  const sw = switchableTransport(t, "gateway-run");
  const { tx, before } = await applyWithFailure(t, sw);
  assert.equal(tx.receipt.apply.ops.find((o) => o.op_id === "gateway:reload").status, "failed");
  assert.equal(tx.receipt.apply.ops.find((o) => o.op_id === "skills:sync").status, "ok");
  sw.state.fail = false; // the fault was transient
  const logBefore = (await t.stubLog()).split("\n").filter(Boolean).length;
  const rolled = await tx.rollback();
  assert.equal(rolled.ok, true, JSON.stringify(rolled));
  const receipt = await assertRestoredVerified(t, tx, before);
  const after = (await t.stubLog()).split("\n").filter(Boolean).slice(logBefore);
  const stop = after.indexOf("gateway\tstop");
  const run = after.indexOf("gateway\trun\t--daemon");
  assert.ok(stop >= 0 && run > stop, `rollback reloaded the gateway with stop then run --daemon: ${after.join(" | ")}`);
  assert.equal(after.some((l) => /restart/.test(l)), false, "never `gateway restart`");
  assert.equal((await t.cat('"$HOME/.hermes/gateway.state"')).trim(), "running");
  const env = await t.envText();
  assert.match(env, /^UNRELATED_SETTING=keep-me$/m);
  assert.match(env, /^ANOTHER_KEY=also-keep$/m);
  assert.ok(receipt.checks.some((c) => c.id === "gateway-reloaded"));
}, { skip: TX_GATE });

gated("transaction: gateway keeps failing at rollback => manual_recovery_required, yet the files are restored byte-for-byte", async (t) => {
  const { tx, before } = await applyWithFailure(t, t.transport({ env: { HSTACK_STUB_FAIL: "gateway-run" } }));
  const rolled = await tx.rollback();
  assert.equal(rolled.ok, false);
  assert.equal(tx.state, "manual_recovery_required", "a failed reload must not be reported as restored_verified");
  assert.match(rolled.detail, /gateway reload failed/);
  await assertFilesRestored(t, before); // the restore itself is not undone by the failed reload
  const receipt = assertReceiptClean(assert, t, tx);
  assert.equal(check(receipt, "restoration").status, "pass");
  assert.equal(check(receipt, "gateway-reloaded").status, "fail");
  assert.equal(receipt.recovery.restoration_verified, false);
  assert.equal(validateReceipt({ ...receipt, state: "restored_verified" }, { requiredChecks: contract.required_checks }).valid, false, "it can never be relabelled restored_verified");
  assert.notEqual((await t.cat('"$HOME/.hermes/gateway.state"')).trim(), "running", "the gateway really is not running");
}, { skip: TX_GATE });

gated("transaction: abandon() after a crash between stage and apply removes staged secrets from the container; user env untouched", async (t) => {
  await t.reset({ priorBot: FAKE.botOld });
  const envShaBefore = await t.fileSha('"$HOME/.hermes/.env"');
  const stateBefore = await t.userStateHash();
  const tx = newTransaction(t);
  assert.equal((await tx.validate()).ok, true);
  assert.equal((await tx.inspect()).ok, true);
  await tx.reviewChanges((review) => review.plan_hash);
  const staged = await tx.stage(SECRET_VALUES);
  assert.equal(staged.ok, true, JSON.stringify(staged));
  assert.equal(tx.state, "staged");
  // premise: the NEW secrets really are sitting staged on the target
  const stagedFiles = (await t.ssh('find "$HOME/.hermes/.hstack" -name env.staged')).stdout.trim();
  assert.match(stagedFiles, /env\.staged$/m);
  assert.ok((await t.cat(stagedFiles.split("\n")[0])).includes(FAKE.bot), "premise: staged copy holds the new token");
  assert.equal(await t.fileSha('"$HOME/.hermes/.env"'), envShaBefore, "staging never touches the live env");

  // simulated crash: the process dies; only the receipt file survives
  const receiptFile = tx.receiptPath;
  const resumed = Transaction.resume({
    receiptFile, blueprint: makeBlueprint(), contract, operator: OPERATOR, transport: t.transport(), receiptDir: t.receipts,
    skillsRoot: FIXTURE_SKILLS, allowNonLinuxTarget: true,
  });
  assert.equal(resumed.state, "staged");
  const out = await resumed.abandon();
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.blocked_reason, "abandoned");
  assert.equal(resumed.state, "staged", "state unchanged");

  assert.equal((await t.ssh('find "$HOME/.hermes/.hstack" -name env.staged | wc -l')).stdout.trim(), "0", "staged secrets removed");
  const holders = (await t.ssh(`grep -rlF -e '${FAKE.bot}' -e '${FAKE.github}' "$HOME" 2>/dev/null; true`)).stdout.trim();
  assert.equal(holders, "", `the NEW secrets exist nowhere on the target any more: ${holders}`);
  assert.equal(await t.fileSha('"$HOME/.hermes/.env"'), envShaBefore, "user env byte-identical");
  assert.equal(await t.userStateHash(), stateBefore, "everything the user owns is as before");
  assert.equal((await t.ssh('find "$HOME/.hermes" -name ".hstack-managed" | wc -l')).stdout.trim(), "0");
  const receipt = assertReceiptClean(assert, t, resumed);
  assert.equal(receipt.changes_applied, false);
  assert.equal(receipt.blocked_reason, "abandoned");
  assert.equal(check(receipt, "abandon").status, "pass");
  await assert.rejects(() => resumed.apply(), /abandon|state/i, "an abandoned transaction cannot be applied");

  // and the target is not left blocked: a fresh transaction can start
  const next = newTransaction(t);
  await next.validate();
  assert.equal((await next.inspect()).ok, true, "no incomplete transaction is left behind");
}, { skip: TX_GATE });

gated("transaction: a user edit of a managed key after apply => manual_recovery_required, nothing overwritten", async (t) => {
  await t.reset();
  const { tx, applied } = await driveToApplied(t);
  assert.equal(applied.ok, true);
  const edit = await t.ssh("sed -i 's/^GITHUB_TOKEN=.*/GITHUB_TOKEN=rotated-by-the-user-by-hand/' \"$HOME/.hermes/.env\"");
  assert.equal(edit.code, 0, edit.stderr);
  const frozen = await t.treeHash('"$HOME/.hermes"', [".hstack", "gateway.state", "outbox.log"]);
  const outcome = await tx.rollback();
  assert.equal(outcome.ok, false);
  assert.equal(tx.state, "manual_recovery_required");
  assert.equal(await t.treeHash('"$HOME/.hermes"', [".hstack", "gateway.state", "outbox.log"]), frozen, "nothing overwritten, nothing deleted");
  assert.match(await t.envText(), /^GITHUB_TOKEN=rotated-by-the-user-by-hand$/m);
  const receipt = assertReceiptClean(assert, t, tx);
  assert.equal(check(receipt, "restoration").status, "fail");
  assert.match(check(receipt, "restoration").detail, /conflict, nothing overwritten: .*env:GITHUB_TOKEN/);
  assert.equal(receipt.recovery.restoration_verified, false);
  assert.equal(JSON.stringify(receipt).includes("rotated-by-the-user-by-hand"), false);
}, { skip: TX_GATE });

// ===============================================================================================
// 4. the Telegram skill's REAL bash blocks over real ssh
// ===============================================================================================
//
// The fenced ```bash blocks of skills/platform-telegram/SKILL.md that belong to the procedure (the
// "Before you start" ssh check and Steps 0-9; NOT the "Rollback" appendix, which is manual/destructive) are
// extracted in document order and run as ONE script, because the skill requires a single shell session.
// They run with the skill's own remote() = `ssh -o BatchMode=yes "$VPS_USER@$VPS_IP" ...`, VPS_USER=operator,
// VPS_IP=127.0.0.1, against the container with a curl TEST DOUBLE and a thin hermes shim (see
// image/hermes-tg-shim). Harness shims, each deliberate and the only departures from "verbatim":
//   S1  `sleep() { :; }`   host-side only: skips the skill's 2s/10s/5s waits (they pace a real gateway). The remote
//                           rollback's own sleeps are NOT shimmed, so rollback still takes ~5s.
//   S2  the blocks are concatenated into one /bin/bash script (macOS bash 3.2 on a Mac, which the skill targets).
//   S3  env: VPS_USER, VPS_IP, TELEGRAM_* and FORCE come from the test; the dry-run's "wait for confirmation" is
//       prose, not code, so AUTO_APPROVE needs no shim. Nothing else is altered; Steps 1, 2, 4, 6, 7, 9 run too.
//   S4  container side: ~/.local/bin gets `curl` (answers only getMe for the fake good token, logs token LENGTH)
//       and `hermes` becomes a shim accepting only the default-profile forms, `config set K -- V`,
//       `gateway status`, `logs gateway -n N` and fixture `gateway ensure --json --timeout 60`.
//       Ensure delegates to the legacy stub's run command and labels readiness as test-double evidence.
//       The shared legacy stub/version pin remain unchanged; this is not live candidate validation.

const SKILL = path.join(REPO, "skills", "platform-telegram", "SKILL.md");

export function extractSkillBlocks(markdown) {
  const blocks = [];
  let heading = "";
  let current = null;
  for (const line of markdown.split("\n")) {
    if (current) {
      if (/^```\s*$/.test(line)) { blocks.push({ heading, code: current.join("\n") }); current = null; } else current.push(line);
      continue;
    }
    const h = /^#{1,3}\s+(.*)$/.exec(line);
    if (h) { heading = h[1]; continue; }
    if (/^```bash\s*$/.test(line)) current = [];
  }
  return blocks;
}

function procedureScript(mutate = (code) => code) {
  const blocks = extractSkillBlocks(readFileSync(SKILL, "utf8")).filter((b) => /^(Before you start|Step [0-9])\b/.test(b.heading));
  const headings = new Set(blocks.map((b) => b.heading.split(" ")[0] + (b.heading.startsWith("Step") ? ` ${b.heading.split(" ")[1]}` : "")));
  for (const need of ["Step 0", "Step 3", "Step 5", "Step 8"]) assert.ok(headings.has(need), `SKILL.md lost its ${need} bash block`);
  const body = blocks.map((b) => mutate(b.code, b.heading)).join("\n\n");
  return `# harness shim S1: pacing only\nsleep() { :; }\n\n${body}\n`;
}

const TG = {
  good: ["424242", `FAKEGOOD${"x".repeat(30)}`].join(":"),
  next: ["737373", `FAKENEWS${"z".repeat(31)}`].join(":"),
  bad: ["909090", `FAKEBAD${"q".repeat(32)}`].join(":"),
  users: "111222333",
  channel: "-100555000111",
};

async function runSkill(t, { token, goodToken, force = false, extraKnobs = {}, mutate } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hstack-tg-script-"));
  const file = path.join(dir, "platform-telegram.sh");
  writeFileSync(file, procedureScript(mutate), { mode: 0o600 });
  const env = {
    ...t.childEnv({ HSTACK_FAKE_GOOD_TOKEN: goodToken ?? token, ...extraKnobs }),
    VPS_USER: SSH_USER,
    VPS_IP: SSH_HOST,
    TELEGRAM_BOT_TOKEN: token,
    TELEGRAM_ALLOWED_USERS: TG.users,
    TELEGRAM_HOME_CHANNEL: TG.channel,
    ...(force ? { FORCE: "1" } : {}),
  };
  const bash = process.platform === "darwin" ? "/bin/bash" : "bash";
  try {
    return await new Promise((resolve) => {
      const child = spawn(bash, [file], { env, stdio: ["ignore", "pipe", "pipe"] });
      const out = [];
      child.stdout.on("data", (c) => out.push(c));
      child.stderr.on("data", (c) => out.push(c));
      const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, output: Buffer.concat(out).toString("utf8") }); });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tgValue = async (t, key) => (await t.ssh(`sed -n 's/^${key}=//p' "$HOME/.hermes/.env" | tail -n1 | tr -d '\\n'`)).stdout;

gated("telegram skill: a bad token aborts at the hard gate before any write", async (t) => {
  await t.reset();
  await t.installTelegramDoubles();
  const stateBefore = await t.userStateHash();
  const envShaBefore = await t.fileSha('"$HOME/.hermes/.env"');

  const r = await runSkill(t, { token: TG.bad, goodToken: TG.good });
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /ABORT: Telegram getMe .* did not accept the token/);
  assert.match(r.output, /Nothing was written\./);
  assert.equal(r.output.includes(TG.bad), false, "the token is never printed");

  assert.equal(await t.fileSha('"$HOME/.hermes/.env"'), envShaBefore);
  assert.equal(await t.userStateHash(), stateBefore, "nothing under ~/.hermes changed");
  assert.equal((await t.ssh('test ! -e "$HOME/.hermes/.hstack-backup" && echo none')).stdout.trim(), "none", "no snapshot: it aborted before the write phase");
  assert.equal(/\tconfig\tset\b|^config\tset\b/m.test(await t.stubLog()), false, "hermes config set was never called");
  const curl = await t.curlLog();
  assert.match(curl, new RegExp(`endpoint=getMe token_len=${TG.bad.length} has_dollar=0 verdict=401`));
  assert.equal(curl.includes(TG.bad), false);
});

gated("telegram skill: the real getMe call carries the EXPANDED token; secrets land in ~/.hermes/.env mode 600, allowlist first", async (t) => {
  await t.reset();
  await t.installTelegramDoubles();
  const r = await runSkill(t, { token: TG.good });
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /Token OK: bot is @hstack_fake_bot/);
  assert.match(r.output, /Telegram secrets confirmed in ~\/\.hermes\/\.env\./);
  assert.match(r.output, /OK: Telegram connected \(bot @hstack_fake_bot\)\./);
  assert.equal(r.output.includes(TG.good), false, "the token is never printed");

  // what the curl double saw: Step 3 (token from the host variable) and Step 8 (token read back from the VPS .env)
  const lines = (await t.curlLog()).split("\n").filter(Boolean);
  assert.equal(lines.length, 2, lines.join("\n"));
  for (const line of lines) {
    assert.match(line, new RegExp(`^argv=-fsS --max-time 15 --config - endpoint=getMe token_len=${TG.good.length} has_dollar=0 verdict=200$`), "expanded token length, no literal $TELEGRAM_BOT_TOKEN, token not in curl argv");
  }

  // the env file
  const mode = (await t.ssh('stat -c %a "$HOME/.hermes/.env"')).stdout.trim();
  assert.equal(mode, "600");
  assert.equal(await tgValue(t, "TELEGRAM_BOT_TOKEN"), TG.good);
  assert.equal(await tgValue(t, "TELEGRAM_ALLOWED_USERS"), TG.users);
  assert.equal(await tgValue(t, "TELEGRAM_HOME_CHANNEL"), TG.channel);
  const env = await t.envText();
  assert.match(env, /^UNRELATED_SETTING=keep-me$/m);
  assert.ok(env.indexOf("TELEGRAM_ALLOWED_USERS=") < env.indexOf("TELEGRAM_BOT_TOKEN="), "the allowlist was written before the token");
  assert.equal((await t.cat('"$HOME/.hermes/config.yaml"')).includes(TG.good), false, "never in config.yaml");
  assert.match(await t.cat('"$HOME/.hermes/config.yaml"'), /^platforms\.telegram\.enabled: true$/m);

  // host-side: no ssh argument ever contained the token
  assert.equal(t.wrapperCalls().join("\n").includes(TG.good), false, "the token never appeared in an ssh argument");
  assert.equal(readFileSync(path.join(DOCKER_DIR, "image", "curl-stub"), "utf8").includes(TG.good), false);
  // finish ran: the snapshot was kept as .prev for a manual undo and the in-progress marker is gone
  assert.equal((await t.ssh('test -d "$HOME/.hermes/.hstack-backup/platform-telegram.prev" && test ! -e "$HOME/.hermes/.hstack-backup/platform-telegram" && echo ok')).stdout.trim(), "ok");
});

gated("telegram skill: a rerun without FORCE is idempotent (exit 0, nothing written)", async (t) => {
  const envShaBefore = await t.fileSha('"$HOME/.hermes/.env"');
  const stateBefore = await t.userStateHash();
  const curlBefore = await t.curlLog();
  const r = await runSkill(t, { token: TG.next, goodToken: TG.next });
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /Telegram already wired\. Set FORCE=1 to rewire\./);
  assert.equal(await t.fileSha('"$HOME/.hermes/.env"'), envShaBefore);
  assert.equal(await t.userStateHash(), stateBefore);
  assert.equal(await t.curlLog(), curlBefore, "getMe was never called: the idempotency check ran first");
});

gated("telegram skill: FORCE=1 rerun with a forced gateway failure rolls back; the old token is back byte-for-byte", async (t) => {
  // state from the previous test: wired with TG.good
  assert.equal(await tgValue(t, "TELEGRAM_BOT_TOKEN"), TG.good, "premise: the previous run left the old, working token");
  const envShaBefore = await t.fileSha('"$HOME/.hermes/.env"');
  const configShaBefore = await t.fileSha('"$HOME/.hermes/config.yaml"');
  // `.hstack-backup` is the skill's own bookkeeping (snapshot / .prev) and legitimately changes on a rollback
  const userState = () => t.treeHash('"$HOME/.hermes"', [".hstack", ".hstack-backup", "cron.seq", "gateway.state", "outbox.log"]);
  const stateBefore = await userState();

  const r = await runSkill(t, { token: TG.next, goodToken: TG.next, force: true, extraKnobs: { HSTACK_STUB_FAIL: "gateway-run" } });
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /FAIL: gateway did not start\. Rolling back\./);
  assert.match(r.output, /rollback: files restored, but the gateway did NOT come back/, "rollback restored the files and honestly reported the gateway");
  assert.equal(r.output.includes(TG.next) || r.output.includes(TG.good), false, "no token printed");

  // premise: the new token WAS written before the failure (so the restore below is not vacuous)
  assert.ok((await t.stubLog()).includes(TG.next), "the new token had been written via hermes config set");
  assert.match(await t.curlLog(), new RegExp(`token_len=${TG.next.length} has_dollar=0 verdict=200`));

  assert.equal(await t.fileSha('"$HOME/.hermes/.env"'), envShaBefore, ".env restored byte for byte (sha256 computed in the container)");
  assert.equal(await tgValue(t, "TELEGRAM_BOT_TOKEN"), TG.good, "the previous working token is back");
  assert.equal(await t.fileSha('"$HOME/.hermes/config.yaml"'), configShaBefore, "config.yaml restored too");
  assert.equal(await userState(), stateBefore, "the whole ~/.hermes user state is as before the failed rewire");
  assert.equal(await t.fileSha('"$HOME/.hermes/.hstack-backup/platform-telegram/.env"'), envShaBefore, "failed gateway recovery retains the active pre-rewire snapshot");
  assert.equal((await t.ssh('stat -c %a "$HOME/.hermes/.env"')).stdout.trim(), "600");
  assert.equal((await t.ssh('test -d "$HOME/.hermes/.hstack-backup/platform-telegram" && echo retained')).stdout.trim(), "retained");
  assert.equal(t.wrapperCalls().join("\n").includes(TG.next), false);

  // Once the gateway fault is cleared, retry only the documented recovery helper.
  const recovered = await runSkill(t, {
    token: TG.good,
    mutate: (code, heading) => heading.startsWith("Step 0") ? `${code}\nrollback || exit 1\nexit 0` : "",
  });
  assert.equal(recovered.code, 0, recovered.output);
  assert.match(recovered.output, /rollback: restored/);
  assert.equal(await t.fileSha('"$HOME/.hermes/.hstack-backup/platform-telegram.prev/.env"'), envShaBefore, "successful retry retires the verified recovery point");
  assert.equal(await t.fileSha('"$HOME/.hermes/.env"'), envShaBefore);
  assert.equal((await t.ssh('test ! -e "$HOME/.hermes/.hstack-backup/platform-telegram" && echo cleared')).stdout.trim(), "cleared");
});
