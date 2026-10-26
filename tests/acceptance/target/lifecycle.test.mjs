import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CRON_SPEC, TXN, TXN2, sandbox } from './helpers/sandbox.mjs';

test('legacy reload = `gateway restart` only (0.15.2 has no `run --daemon`, no -y); needs applied (or restored)', () => {
  const sb = sandbox();
  try {
    sb.stageAll();
    const early = sb.run(['reload', TXN]);
    assert.equal(early.status, 3);
    assert.equal(early.kv.error, 'not_applied');
    assert.deepEqual(sb.stubCalls().filter((a) => a[0] === 'gateway'), []);
    assert.equal(sb.apply(TXN, [CRON_SPEC]).status, 0);
    const r = sb.run(['reload', TXN]);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.kv.reloaded, '1');
    const gw = sb.stubCalls().filter((a) => a[0] === 'gateway');
    assert.deepEqual(gw, [['gateway', 'restart']]);
    assert.ok(!sb.stubCalls().flat().some((arg) => ['--daemon', 'run', 'stop', '-y', '--yes'].includes(arg)));
    assert.equal(readFileSync(join(sb.h, 'gateway.state'), 'utf8').trim(), 'running');
    // a failing gateway restart is a failure, not a success
    const bad = sb.run(['reload', TXN], { env: { HSTACK_STUB_FAIL: 'gateway-restart' } });
    assert.equal(bad.status, 1);
    assert.equal(bad.kv.error, 'gateway_restart_failed');
    assert.notEqual(bad.kv.reloaded, '1');
    // reload after a restore is allowed (pick up the restored env)
    sb.restore();
    assert.equal(sb.run(['reload', TXN]).status, 0);
  } finally { sb.cleanup(); }
});

test('reload rejects a bad delay setting', () => {
  const sb = sandbox();
  try {
    sb.stageAll();
    sb.apply();
    assert.equal(sb.run(['reload', TXN], { env: { HSTACK_RELOAD_DELAY: '999' } }).status, 2);
    assert.equal(sb.run(['reload', TXN], { env: { HSTACK_RELOAD_DELAY: '$(id)' } }).status, 2);
  } finally { sb.cleanup(); }
});

test('commit needs `applied`, is idempotent, and keeps the backup; an interrupted apply cannot be committed', () => {
  const sb = sandbox();
  try {
    sb.stageAll();
    assert.equal(sb.commit().status, 3, 'not applied');
    const failing = sb.run(['apply', TXN, '--cron', CRON_SPEC], { env: { HSTACK_STUB_FAIL: 'cron-create' } });
    assert.equal(failing.status, 1);
    const c = sb.commit();
    assert.equal(c.status, 3);
    assert.equal(c.kv.error, 'not_applied');
    assert.equal(sb.apply(TXN, [CRON_SPEC]).status, 0);
    assert.equal(sb.commit().status, 0);
    assert.equal(sb.commit().status, 0);
    assert.ok(existsSync(join(sb.txnPath(), 'done')));
    assert.ok(existsSync(join(sb.txnPath(), 'meta')));
    assert.equal(sb.apply(TXN, [CRON_SPEC]).status, 3, 'a finished txn cannot be re-applied');
  } finally { sb.cleanup(); }
});

test('purge only after done/restored; removes only that txn dir', () => {
  const sb = sandbox();
  try {
    sb.write('.hermes/.env', 'A=1\n', 0o600);
    sb.stageAll();
    sb.apply();
    const refused = sb.run(['purge', TXN]);
    assert.equal(refused.status, 3);
    assert.equal(refused.kv.error, 'txn_not_final');
    assert.ok(existsSync(sb.txnPath()));
    sb.commit();
    sb.backup(TXN2);
    sb.restore(TXN2);
    const envAfter = sb.env();
    const p = sb.run(['purge', TXN]);
    assert.equal(p.status, 0, p.stdout);
    assert.equal(p.kv.purged, '1');
    assert.ok(!existsSync(sb.txnPath()));
    assert.ok(existsSync(sb.txnPath(TXN2)), 'other txn dirs are untouched');
    assert.equal(sb.env(), envAfter, 'purge never touches live files');
    assert.equal(sb.run(['purge', TXN2]).status, 0);
    assert.equal(sb.run(['purge', TXN2]).status, 1, 'already gone');
    assert.ok(existsSync(sb.statePath));
    // a purged backup cannot be restored
    assert.equal(sb.restore(TXN).kv.error, 'backup_missing');
  } finally { sb.cleanup(); }
});

test('the script keeps its promises: umask 077, no eval, no hermes doctor/--fix, no `gateway run --daemon` anywhere in the source', () => {
  const src = readFileSync(new URL('../../../packages/acceptance/target/hstack-target.sh', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.match(code, /^umask 077$/m);
  assert.ok(!/\beval\b/.test(code), 'eval found');
  assert.ok(!/\bmapfile\b|\breadarray\b|declare -A|local -A/.test(code), 'bash-4-only construct found');
  assert.ok(!/run_hermes\s+doctor|--fix/.test(code));
  assert.ok(!/--daemon|gateway run|gateway stop/.test(code), 'only `gateway restart` (legacy) or the bundled native adapter reloads the gateway');
  assert.ok(!/\bsed -i\b|\bstat --format|\breadlink -f\b|\bdate -d\b|\bgrep -P\b|\bxargs -r\b/.test(code), 'GNU-only flag found');
  assert.ok(!/ set -x|^set -x/m.test(code));
});

test('concurrent mutating operations are serialised by a lock and a stale lock is recovered', () => {
  const sb = sandbox();
  try {
    sb.backup();
    // a lock owned by a live pid (this test process) blocks quickly with exit 4
    sb.write('.hermes/.hstack/lock.d/pid', String(process.pid) + '\n');
    const blocked = sb.run(['restore', TXN]);
    assert.equal(blocked.status, 4);
    assert.equal(blocked.kv.error, 'locked');
    // a lock owned by a dead pid is stale and recovered
    sb.write('.hermes/.hstack/lock.d/pid', '999999\n');
    const r = sb.run(['restore', TXN]);
    assert.equal(r.status, 0, r.stdout);
    assert.ok(!existsSync(join(sb.statePath, 'lock.d')), 'lock released');
  } finally { sb.cleanup(); }
});
