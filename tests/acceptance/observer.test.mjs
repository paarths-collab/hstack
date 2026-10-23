// These observe only the offline stub. No real GitHub or Telegram is contacted.
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { FAKE, Target, driveToApplied, fingerprint } from "./helpers/harness.mjs";
import { freshStubDeliveries } from "./helpers/stub-observer.mjs";
import { DockerTarget } from "./docker/helpers/docker-target.mjs";

const runId = "a".repeat(32);
const otherRun = "b".repeat(32);
const message = (id = runId, to = FAKE.chat, body = "new brief") => `to=${to} run=${id} body=${body}\n`;

test("stub observation accepts only fresh complete output correlated to the current run", () => {
  const old = message(otherRun, FAKE.otherChat, FAKE.vulnerableLeak);
  assert.deepEqual(freshStubDeliveries(old, `${old}${message(otherRun)}${message()}`, runId, [FAKE.vulnerableLeak]), [
    { to_fp: fingerprint(FAKE.chat), body_has_secret: false },
  ]);
  for (const after of [old, `${old}${message(otherRun)}`, message(), `${old}${message().trimEnd()}`]) {
    assert.deepEqual(freshStubDeliveries(old, after, runId), [], "stale, unrelated, replaced or partial outbox cannot pass");
  }
  assert.deepEqual(freshStubDeliveries("partial", `partial${message()}`, runId), []);
  assert.deepEqual(freshStubDeliveries("", message(runId, FAKE.otherChat, FAKE.vulnerableLeak), runId, [FAKE.vulnerableLeak]), [
    { to_fp: fingerprint(FAKE.otherChat), body_has_secret: true },
  ]);
});

test("a failed current cron dispatch cannot reuse an older successful transaction's delivery", async () => {
  const target = new Target();
  try {
    target.setFixture("A fixture GitHub issue.");
    const first = await driveToApplied(target, { observer: target.observer() });
    assert.equal((await first.tx.verify()).ok, true);
    const oldOutput = readFileSync(target.outboxPath, "utf8");
    const second = await driveToApplied(target, { observer: target.observer({ env: { HSTACK_STUB_FAIL: "cron-run" } }) });
    const outcome = await second.tx.verify();
    assert.equal(outcome.ok, false);
    assert.equal(second.tx.state, "applied_unverified");
    assert.equal(second.tx.receipt.checks.find((check) => check.id === "private-destination-delivery").status, "unknown");
    assert.equal(readFileSync(target.outboxPath, "utf8"), oldOutput, "no new delivery was emitted");
  } finally { target.cleanup(); }
});

test("historic foreign messages do not contaminate a newly correlated successful brief", async () => {
  const target = new Target();
  try {
    writeFileSync(target.outboxPath, message(otherRun, FAKE.otherChat, FAKE.vulnerableLeak));
    const { tx } = await driveToApplied(target, { observer: target.observer() });
    assert.equal((await tx.verify()).ok, true);
    assert.equal(tx.receipt.checks.find((check) => check.id === "private-destination-delivery").status, "pass");
    assert.equal(tx.receipt.recovery.external_effects.find((effect) => effect.kind === "telegram_message_misdirected"), undefined);
    assert.equal(readFileSync(target.outboxPath, "utf8").trim().split("\n").length, 2);
  } finally { target.cleanup(); }
});

test("successful cron exit without current-run output cannot bless old or unrelated deliveries", async () => {
  for (const mode of ["none", "unrelated", "replace", "partial"]) {
    const target = new Target();
    try {
      writeFileSync(target.outboxPath, message(otherRun));
      const underlying = target.transport.bind(target);
      target.transport = (options) => {
        const transport = underlying(options);
        return { kind: transport.kind, exec: async (op) => {
          const currentRun = /HSTACK_STUB_RUN_ID=([0-9a-f]{32}) hermes cron run/.exec(op.remote)?.[1];
          if (!currentRun) return transport.exec(op);
          if (mode === "unrelated") appendFileSync(target.outboxPath, message(otherRun));
          if (mode === "replace") writeFileSync(target.outboxPath, message(currentRun));
          if (mode === "partial") appendFileSync(target.outboxPath, message(currentRun).trimEnd());
          return { code: 0, stdout: "", stderr: "", transportError: false };
        } };
      };
      const { tx } = await driveToApplied(target, { observer: target.observer() });
      assert.equal((await tx.verify()).ok, false, mode);
      assert.equal(tx.state, "applied_unverified", mode);
      assert.equal(tx.receipt.checks.find((check) => check.id === "private-destination-delivery").status, "unknown", mode);
    } finally { target.cleanup(); }
  }
});

test("a cron run with uncertain transport outcome cannot pass despite correlated output", async () => {
  const target = new Target();
  try {
    const underlying = target.transport.bind(target);
    target.transport = (options) => {
      const transport = underlying(options);
      return { kind: transport.kind, exec: async (op) => {
        const result = await transport.exec(op);
        return op.remote.includes("HSTACK_STUB_RUN_ID=") ? { ...result, transportError: true } : result;
      } };
    };
    const { tx } = await driveToApplied(target, { observer: target.observer() });
    assert.equal((await tx.verify()).ok, false);
    assert.equal(tx.state, "applied_unverified");
    assert.equal(readFileSync(target.outboxPath, "utf8").trim().split("\n").length, 1, "the send happened but its dispatch success was not confirmed");
  } finally { target.cleanup(); }
});

test("Docker observer glue enforces successful dispatch and the same per-run freshness boundary offline", async () => {
  // Exercise the real Docker observer method with a local SSH response double.
  // No Docker constructor, daemon, ssh process or container is used by this test.
  for (const mode of ["healthy", "failed", "uncertain", "stale", "unrelated", "replaced", "list-failed", "ambiguous"]) {
    let outbox = message(otherRun);
    let dispatches = 0;
    const fake = {
      cat: async () => outbox,
      ssh: async (command) => {
        if (command.endsWith("hermes cron list")) return {
          code: mode === "list-failed" ? 1 : 0,
          stdout: `job-1\t0 8 * * *\t[hstack:founder-brief] brief\n${mode === "ambiguous" ? "job-2\t0 9 * * *\t[hstack:founder-brief] other\n" : ""}`,
        };
        const id = /HSTACK_STUB_RUN_ID=([0-9a-f]{32}) hermes cron run job-1$/.exec(command)?.[1];
        assert.ok(id, "the dispatch gets an explicit per-run correlation marker");
        dispatches += 1;
        if (["healthy", "failed", "uncertain"].includes(mode)) outbox += message(id);
        if (mode === "unrelated") outbox += message(otherRun);
        if (mode === "replaced") outbox = message(id);
        return { code: mode === "failed" ? 1 : 0, stdout: "", transportError: mode === "uncertain" };
      },
    };
    const result = await DockerTarget.prototype.observer.call(fake).delivery();
    assert.deepEqual(result.deliveries, mode === "healthy" ? [{ to_fp: fingerprint(FAKE.chat), body_has_secret: false }] : [], mode);
    assert.equal(dispatches, ["list-failed", "ambiguous"].includes(mode) ? 0 : 1, mode);
  }
});
