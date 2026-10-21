import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASH, CRON_SPEC, FAKE, SCRIPT, TXN, filesContaining, sandbox, skillTar } from './helpers/sandbox.mjs';

const PRE_ENV = `A=1\nTELEGRAM_BOT_TOKEN=${FAKE.botOld}\n`;
const NEW_VALUES = [FAKE.github, FAKE.bot, FAKE.allowed, FAKE.chat];

function seeded() {
  const sb = sandbox();
  sb.write('.hermes/.env', PRE_ENV, 0o600);
  return sb;
}

// ---------------------------------------------------------------- secrets at rest (F3)
test('new secret values leave the txn dir once apply succeeds; env.bak stays (names disclosed) until purge removes everything', () => {
  const sb = seeded();
  try {
    sb.stageAll();
    assert.ok(existsSync(join(sb.txnPath(), 'env.staged')));
    const a = sb.apply(TXN, [CRON_SPEC]);
    assert.equal(a.status, 0, a.stdout);
    assert.ok(!existsSync(join(sb.txnPath(), 'env.staged')), 'env.staged must be deleted after a successful apply');
    for (const v of NEW_VALUES) assert.deepEqual(filesContaining(sb.txnPath(), v), [], 'new secret value left in txn dir');
    assert.deepEqual(filesContaining(sb.txnPath(), FAKE.botOld), ['env.bak'], 'previous secret kept for rollback');
    const c = sb.commit();
    assert.equal(c.kv.secrets_retained, 'env.bak');
    assert.ok(!c.stdout.includes(FAKE.botOld));
    const p = sb.run(['purge', TXN]);
    assert.equal(p.status, 0);
    assert.ok(!existsSync(sb.txnPath()));
    assert.deepEqual(filesContaining(sb.root, FAKE.botOld).filter((h) => h !== 'stub.log'), [], 'purge removes env.bak too');
    for (const v of NEW_VALUES) assert.deepEqual(filesContaining(sb.root, v).filter((h) => h !== 'stub.log'), ['home/.hermes/.env']);
  } finally { sb.cleanup(); }
});

test('a failed apply keeps env.staged (retry needs it); restore completion deletes it and reports secrets_retained', () => {
  const sb = seeded();
  try {
    sb.stageAll();
    assert.notEqual(sb.run(['apply', TXN, '--cron', CRON_SPEC], { env: { HSTACK_STUB_FAIL: 'cron-create' } }).status, 0);
    assert.ok(existsSync(join(sb.txnPath(), 'env.staged')));
    const r = sb.restore();
    assert.equal(r.status, 0, r.stdout);
    assert.ok(!existsSync(join(sb.txnPath(), 'env.staged')));
    for (const v of NEW_VALUES) assert.deepEqual(filesContaining(sb.txnPath(), v), []);
    assert.equal(r.kv.secrets_retained, 'env.bak');
    assert.equal(r.kv.gateway_reloaded, '0');
    assert.equal(sb.restore().kv.secrets_retained, 'env.bak');
  } finally { sb.cleanup(); }
  // restore of a txn that never reached apply also removes the staged copy
  const sb2 = seeded();
  try {
    sb2.stageAll();
    assert.equal(sb2.restore().status, 0);
    assert.ok(!existsSync(join(sb2.txnPath(), 'env.staged')));
    for (const v of NEW_VALUES) assert.deepEqual(filesContaining(sb2.txnPath(), v), []);
  } finally { sb2.cleanup(); }
  // a refused (conflicting) restore changes nothing, including the staged copy
  const sb3 = seeded();
  try {
    sb3.stageAll();
    assert.notEqual(sb3.run(['apply', TXN, '--cron', CRON_SPEC], { env: { HSTACK_STUB_FAIL: 'cron-create' } }).status, 0);
    writeFileSync(sb3.cfgPath, 'edited: 1\n');
    assert.equal(sb3.restore().status, 3);
    assert.ok(existsSync(join(sb3.txnPath(), 'env.staged')));
  } finally { sb3.cleanup(); }
});

test('apply can be re-run after env.staged was deleted without disturbing exact-byte restore', () => {
  const sb = seeded();
  try {
    sb.stageAll();
    assert.equal(sb.apply(TXN, [CRON_SPEC]).status, 0);
    const again = sb.apply(TXN, [CRON_SPEC]);
    assert.equal(again.status, 0, again.stdout);
    assert.equal(again.kv.env_swapped, '0');
    assert.equal(again.kv['cron_founder-brief'], 'unchanged');
    const r = sb.restore();
    assert.equal(r.status, 0, r.stdout);
    assert.equal(sb.env(), PRE_ENV);
  } finally { sb.cleanup(); }
});

test('restore never touches the gateway; reload after restore is allowed and emits reloaded=1', () => {
  const sb = seeded();
  try {
    sb.stageAll();
    sb.apply(TXN, [CRON_SPEC]);
    assert.equal(sb.restore().status, 0);
    assert.deepEqual(sb.stubCalls().filter((a) => a[0] === 'gateway'), [], 'restore must not reload');
    const rl = sb.run(['reload', TXN]);
    assert.equal(rl.status, 0, rl.stdout);
    assert.equal(rl.kv.reloaded, '1');
    assert.deepEqual(sb.stubCalls().filter((a) => a[0] === 'gateway'), [['gateway', 'stop'], ['gateway', 'run', '--daemon']]);
    // also fine when the second restore is the "already restored" no-op
    assert.equal(sb.restore().kv.already_restored, '1');
    assert.equal(sb.run(['reload', TXN]).kv.reloaded, '1');
  } finally { sb.cleanup(); }
});

// ---------------------------------------------------------------- locking (F12a)
function lockDir(sb) { return join(sb.statePath, 'lock.d'); }
function agedLock(sb, pid) {
  mkdirSync(lockDir(sb), { recursive: true });
  if (pid !== null) writeFileSync(join(lockDir(sb), 'pid'), `${pid}\n`);
  const old = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(lockDir(sb), old, old);
}

test('lock: a live holder blocks (exit 4 locked); a fresh pid-less lock blocks; neither is removed', () => {
  const sb = seeded();
  try {
    sb.backup();
    mkdirSync(lockDir(sb), { recursive: true });
    writeFileSync(join(lockDir(sb), 'pid'), `${process.pid}\n`);
    const live = sb.run(['restore', TXN]);
    assert.equal(live.status, 4);
    assert.equal(live.kv.error, 'locked');
    assert.ok(existsSync(lockDir(sb)));
    writeFileSync(join(lockDir(sb), 'pid'), '');
    const fresh = sb.run(['restore', TXN]);
    assert.equal(fresh.status, 4, 'a lock without pid that is not old yet may belong to a live process that has not written its pid');
    assert.ok(existsSync(lockDir(sb)));
  } finally { sb.cleanup(); }
});

test('lock: a dead holder and an OLD pid-less lock (killed between mkdir and pid write) are recovered', () => {
  for (const pid of [999999, null, '']) {
    const sb = seeded();
    try {
      sb.backup();
      agedLock(sb, pid);
      const r = sb.run(['restore', TXN]);
      assert.equal(r.status, 0, `pid=${pid}: ${r.stdout}`);
      assert.ok(!existsSync(lockDir(sb)), 'lock released');
      assert.ok(!existsSync(join(sb.statePath, 'lock.reap')), 'reap guard released');
    } finally { sb.cleanup(); }
  }
});

test('lock: several contenders racing for one stale lock all proceed one at a time and none is lost', async () => {
  const sb = seeded();
  try {
    sb.stageAll();
    sb.apply(TXN, [CRON_SPEC]);
    agedLock(sb, 999999);
    const run = () => new Promise((resolve) => {
      const c = spawn('env', ['-i', `HOME=${sb.home}`, 'PATH=/usr/bin:/bin', `HSTACK_STUB_LOG=${sb.log}`, BASH, SCRIPT, 'commit', TXN], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.on('close', (status) => resolve({ status, out }));
    });
    const results = await Promise.all([run(), run(), run(), run()]);
    for (const r of results) assert.ok(r.status === 0 || r.status === 4, JSON.stringify(r));
    assert.ok(results.some((r) => r.status === 0));
    assert.ok(existsSync(join(sb.txnPath(), 'done')));
    assert.ok(!existsSync(lockDir(sb)) && !existsSync(join(sb.statePath, 'lock.reap')));
  } finally { sb.cleanup(); }
});

// ---------------------------------------------------------------- tampered plan (F12b)
test('restore re-validates skills.plan before any destructive path use (traversal, bad kind, bad hash)', () => {
  const tampers = [
    ['../victim', 'new', 'a'.repeat(64), 'absent'],
    ['alpha-skill/../../victim', 'new', 'a'.repeat(64), 'absent'],
    ['$(touch pwned)', 'new', 'a'.repeat(64), 'absent'],
    ['Alpha', 'new', 'a'.repeat(64), 'absent'],
    ['', 'new', 'a'.repeat(64), 'absent'],
    ['alpha-skill', 'delete', 'a'.repeat(64), 'absent'],
    ['alpha-skill', 'new', 'not-a-hash', 'absent'],
  ];
  for (const [name, kind, newsha, priorsha] of tampers) {
    const sb = seeded();
    try {
      sb.write('.hermes/victim/precious.txt', 'do not delete\n');
      sb.backup();
      assert.equal(sb.syncSkills(skillTar({ 'alpha-skill': { 'SKILL.md': 'a\n' } }), 'alpha-skill').status, 0);
      sb.apply();
      writeFileSync(join(sb.txnPath(), 'skills.plan'), `${name}\t${kind}\t${newsha}\t${priorsha}\n`);
      const before = sb.hash();
      const r = sb.restore();
      assert.equal(r.status, 1, JSON.stringify([name, kind]));
      assert.equal(r.kv.error, 'backup_corrupt');
      assert.match(r.kv.detail, /^skills_plan_invalid_/);
      assert.equal(sb.hash(), before, 'nothing may be modified');
      assert.equal(readFileSync(join(sb.h, 'victim', 'precious.txt'), 'utf8'), 'do not delete\n');
      assert.ok(!existsSync(join(sb.home, 'pwned')));
    } finally { sb.cleanup(); }
  }
});

// ---------------------------------------------------------------- PATH (F12c)
test('a user-writable dir in front of PATH cannot shadow the tools the script uses', () => {
  const sb = seeded();
  try {
    const canary = join(sb.root, 'canary');
    const bin = join(sb.home, '.local', 'bin');
    for (const tool of ['awk', 'sed', 'grep', 'find', 'tar', 'sha256sum', 'shasum', 'stat', 'cp', 'mv', 'tr', 'cut', 'sort', 'head', 'wc', 'date', 'uname', 'chmod', 'rm', 'mkdir', 'cat', 'kill']) {
      const p = join(bin, tool);
      writeFileSync(p, `#!/bin/sh\ntouch '${canary}'\nexit 97\n`);
      chmodSync(p, 0o755);
    }
    const path = `${bin}:/usr/bin:/bin`;
    const run = (args, o = {}) => sb.run(args, { path, ...o });
    const i = run(['inspect']);
    assert.equal(i.status, 0, i.stdout + i.stderr);
    assert.equal(i.kv.runtime_version.length > 0, true);
    const b = run(['backup', TXN, '--keys', 'GITHUB_TOKEN,TELEGRAM_BOT_TOKEN']);
    assert.equal(b.status, 0, b.stdout);
    assert.equal(run(['put-env', TXN, 'GITHUB_TOKEN', '--allow', 'GITHUB_TOKEN,TELEGRAM_BOT_TOKEN'], { input: FAKE.github + '\n' }).status, 0);
    assert.equal(run(['apply', TXN]).status, 0);
    assert.equal(run(['restore', TXN]).status, 0);
    assert.ok(!existsSync(canary), 'a shadowing binary in ~/.local/bin was executed');
    // hermes itself is still resolved from ~/.local/bin
    assert.ok(sb.stubCalls().length > 0);
  } finally { sb.cleanup(); }
});
