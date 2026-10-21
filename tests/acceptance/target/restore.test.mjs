import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CRON_SPEC, FAKE, KEYS, TXN, modeOf, sandbox } from './helpers/sandbox.mjs';

const PRE_ENV = [
  'A=1',
  `TELEGRAM_BOT_TOKEN=${FAKE.botOld}`,
  'TELEGRAM_ALLOWED_USERS=999000111',
  '# user comment',
  'ZLAST=no-trailing-newline',
].join('\n');

// `.hstack` legitimately keeps the backup after a restore; compare everything else.
const STATE = ['home/.hermes/.hstack'];

function prepared(extra = {}) {
  const sb = sandbox();
  sb.write('.hermes/.env', PRE_ENV, 0o640);
  sb.write('.hermes/config.yaml', 'model: some-model\n', 0o644);
  sb.write('.hermes/skills/user-skill/SKILL.md', 'mine\n');
  sb.write('.hermes/cron.db', 'job-9\t5 5 * * *\tmy own unrelated job\n');
  sb.write('.hermes/cron.seq', '9\n');
  Object.assign(sb, extra);
  return sb;
}

test('interruption mid-apply: `applying` marker present, no `applied`; restore returns to the exact pre-state', () => {
  const sb = prepared();
  try {
    const pre = sb.hash(STATE);
    sb.stageAll();
    const a = sb.run(['apply', TXN, '--cron', CRON_SPEC], { env: { HSTACK_STUB_FAIL: 'cron-create' } });
    assert.notEqual(a.status, 0);
    assert.equal(a.kv.error, 'cron_create_failed');
    assert.equal(a.kv.applied, undefined);
    const t = sb.txnPath();
    assert.ok(existsSync(join(t, 'applying')), 'write-ahead marker missing');
    assert.ok(!existsSync(join(t, 'applied')), 'applied marker must not exist after an interrupted apply');
    // the env swap already happened (that is the interesting partial state)
    assert.ok(sb.env().includes(`GITHUB_TOKEN=${FAKE.github}`));
    assert.notEqual(sb.hash(STATE), pre);
    // verify on a half-applied txn cannot pass
    const v = sb.verify();
    assert.equal(v.kv.apply_marker, 'applying');
    assert.equal(v.kv['check.schedule-single'], 'fail');
    // restore works and returns to the exact pre-state (bytes, modes, absent files)
    const r = sb.restore();
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.kv.restore_verified, '1');
    assert.equal(sb.hash(STATE), pre);
    assert.equal(sb.env(), PRE_ENV);
    assert.equal(modeOf(sb.envPath), '640');
  } finally { sb.cleanup(); }
});

test('apply can be re-run after a transient failure and then completes without duplicating anything', () => {
  const sb = prepared();
  try {
    sb.stageAll();
    assert.notEqual(sb.run(['apply', TXN, '--cron', CRON_SPEC], { env: { HSTACK_STUB_FAIL: 'cron-create' } }).status, 0);
    const second = sb.run(['apply', TXN, '--cron', CRON_SPEC]);
    assert.equal(second.status, 0, second.stdout);
    assert.equal(second.kv.env_swapped, '0');
    assert.equal(second.kv['cron_founder-brief'], 'created');
    assert.equal(second.kv.applied, '1');
    assert.equal(sb.cron().split('\n').filter((l) => l.includes('[hstack:founder-brief]')).length, 1);
  } finally { sb.cleanup(); }
});

test('restore puts the PREVIOUS secret back byte-for-byte and deletes keys that did not exist before', () => {
  const sb = prepared();
  try {
    sb.stageAll();
    assert.equal(sb.apply().status, 0);
    const now = sb.env();
    assert.ok(now.includes(FAKE.bot) && !now.includes(FAKE.botOld));
    assert.ok(now.includes('GITHUB_TOKEN=') && now.includes('TELEGRAM_HOME_CHANNEL='));
    const r = sb.restore();
    assert.equal(r.status, 0, r.stdout);
    assert.equal(sb.env(), PRE_ENV, 'exact original bytes, including the missing final newline');
    assert.ok(!sb.env().includes('GITHUB_TOKEN') && !sb.env().includes('TELEGRAM_HOME_CHANNEL'));
    assert.ok(Buffer.from(sb.env()).includes(Buffer.from(FAKE.botOld)));
    assert.equal(modeOf(sb.envPath), '640');
    for (const v of Object.values(FAKE)) assert.ok(!r.stdout.includes(v) && !r.stderr.includes(v));
  } finally { sb.cleanup(); }
});

test('unrelated edits made after apply are preserved (not a conflict); managed keys still return to their prior lines', () => {
  const sb = prepared();
  try {
    sb.write('.hermes/.env', `A=1\nTELEGRAM_HOME_CHANNEL=oldchat1\nB=2\nTELEGRAM_HOME_CHANNEL=oldchat2\nTELEGRAM_BOT_TOKEN=${FAKE.botOld}\n`, 0o600);
    sb.stageAll();
    assert.equal(sb.apply().status, 0);
    // the user edits unrelated state: changes A, adds a key, adds a skill, adds a cron entry
    writeFileSync(sb.envPath, sb.env().replace('A=1', 'A=edited-by-user') + 'NEWUSERKEY=hello\n');
    sb.write('.hermes/skills/added-later/SKILL.md', 'later\n');
    appendFileSync(sb.cronPath, 'job-77\t1 1 * * *\tadded later by the user\n');
    const r = sb.restore();
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.kv.restore_verified, '1');
    const env = sb.env();
    assert.ok(env.includes('A=edited-by-user') && env.includes('NEWUSERKEY=hello') && env.includes('B=2'));
    assert.ok(!env.includes('GITHUB_TOKEN'));
    // both original duplicate lines are back, in order, adjacent at the first position
    assert.ok(env.indexOf('TELEGRAM_HOME_CHANNEL=oldchat1') < env.indexOf('TELEGRAM_HOME_CHANNEL=oldchat2'));
    assert.ok(env.indexOf('TELEGRAM_HOME_CHANNEL=oldchat2') < env.indexOf('B=2'), 'duplicates return adjacent, at the first position');
    assert.equal((env.match(/^TELEGRAM_HOME_CHANNEL=/gm) || []).length, 2);
    assert.ok(env.includes(`TELEGRAM_BOT_TOKEN=${FAKE.botOld}`) && !env.includes(FAKE.bot));
    assert.ok(existsSync(join(sb.skillsPath, 'added-later', 'SKILL.md')));
    assert.ok(sb.cron().includes('added later by the user'));
  } finally { sb.cleanup(); }
});

test('a MANAGED key changed after apply => exit 3, conflict names it, tree byte-identical (nothing partially restored)', () => {
  const sb = prepared();
  try {
    sb.stageAll();
    assert.equal(sb.apply(TXN, [CRON_SPEC]).status, 0);
    writeFileSync(sb.envPath, sb.env().replace(/^TELEGRAM_ALLOWED_USERS=.*$/m, 'TELEGRAM_ALLOWED_USERS=555666777'));
    const before = sb.hash();
    const r = sb.restore();
    assert.equal(r.status, 3);
    assert.equal(r.kv.error, 'restore_conflict');
    assert.equal(r.kv.conflict, 'env:TELEGRAM_ALLOWED_USERS');
    assert.equal(sb.hash(), before, 'a refused restore changed the sandbox');
    assert.ok(!existsSync(join(sb.txnPath(), 'restored')));
    for (const v of ['555666777', FAKE.bot]) assert.ok(!r.stdout.includes(v) && !r.stderr.includes(v));
  } finally { sb.cleanup(); }
});

test('config.yaml edited after apply => conflict=config; own cron entry edited => conflict=cron:<id>; several conflicts are all listed', () => {
  const sb = prepared();
  try {
    sb.stageAll();
    assert.equal(sb.apply(TXN, [CRON_SPEC]).status, 0);
    writeFileSync(sb.cfgPath, 'model: edited\n');
    let before = sb.hash();
    let r = sb.restore();
    assert.equal(r.status, 3);
    assert.equal(r.kv.conflict, 'config');
    assert.equal(sb.hash(), before);

    writeFileSync(sb.cronPath, sb.cron().replace('0 9 * * *', '0 10 * * *'));
    before = sb.hash();
    r = sb.restore();
    assert.equal(r.status, 3);
    assert.deepEqual(r.kv.conflict.split(',').sort(), ['config', 'cron:founder-brief']);
    assert.equal(sb.hash(), before);
  } finally { sb.cleanup(); }
});

test('a second restore reports already_restored=1 and changes nothing', () => {
  const sb = prepared();
  try {
    sb.stageAll();
    sb.apply(TXN, [CRON_SPEC]);
    assert.equal(sb.restore().status, 0);
    const before = sb.hash();
    const r = sb.restore();
    assert.equal(r.status, 0);
    assert.equal(r.kv.already_restored, '1');
    assert.equal(sb.hash(), before);
  } finally { sb.cleanup(); }
});

test('missing backup => exit 1 backup_missing and nothing is created; corrupt backup => exit 1 backup_corrupt and nothing is modified', () => {
  const sb = sandbox();
  try {
    const before = sb.hash();
    const r = sb.restore();
    assert.equal(r.status, 1);
    assert.equal(r.kv.error, 'backup_missing');
    assert.equal(sb.hash(), before);
    assert.ok(!existsSync(sb.statePath), 'a failed restore must not create state');
  } finally { sb.cleanup(); }

  for (const sabotage of [
    (t) => appendFileSync(join(t, 'env.bak'), 'TAMPERED=1\n'),
    (t) => rmSync(join(t, 'meta')),
    (t) => rmSync(join(t, 'integrity')),
    (t) => writeFileSync(join(t, 'prior.keys'), 'GITHUB_TOKEN\tpresent\tdeadbeef\n'),
  ]) {
    const sb2 = prepared();
    try {
      sb2.stageAll();
      sb2.apply(TXN, [CRON_SPEC]);
      sabotage(sb2.txnPath());
      const before = sb2.hash();
      const r = sb2.restore();
      assert.equal(r.status, 1);
      assert.equal(r.kv.error, 'backup_corrupt');
      assert.equal(sb2.hash(), before);
    } finally { sb2.cleanup(); }
  }
});

test('restore before apply ever ran (backup + staging only) is a clean no-op rollback', () => {
  const sb = prepared();
  try {
    const pre = sb.hash(STATE);
    sb.stageAll();
    const r = sb.restore();
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.kv.restore_verified, '1');
    assert.equal(sb.hash(STATE), pre);
  } finally { sb.cleanup(); }
});

test('env that did not exist: restore removes the file we created; keeps it (with only the user lines) if the user added some', () => {
  for (const userAdds of [false, true]) {
    const sb = sandbox();
    try {
      sb.stageAll();
      assert.equal(sb.apply().status, 0);
      assert.equal(modeOf(sb.envPath), '600');
      if (userAdds) appendFileSync(sb.envPath, 'USERVAR=1\n');
      assert.equal(sb.restore().status, 0);
      if (userAdds) assert.equal(sb.env(), 'USERVAR=1\n');
      else { assert.ok(!existsSync(sb.envPath)); assert.deepEqual(readdirSync(sb.h), ['.hstack']); }
    } finally { sb.cleanup(); }
  }
});

test('restore works after commit (a later rollback of an accepted txn) and keeps the backup', () => {
  const sb = prepared();
  try {
    sb.stageAll();
    sb.apply(TXN, [CRON_SPEC]);
    assert.equal(sb.commit().status, 0);
    const r = sb.restore();
    assert.equal(r.status, 0, r.stdout);
    assert.equal(sb.env(), PRE_ENV);
    assert.ok(existsSync(join(sb.txnPath(), 'env.bak')), 'backup must be retained');
    assert.equal(sb.cron().includes('[hstack:founder-brief]'), false);
  } finally { sb.cleanup(); }
});

test('every managed key is reported by name only; KEYS constant sanity', () => {
  assert.deepEqual(KEYS, ['GITHUB_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USERS', 'TELEGRAM_HOME_CHANNEL']);
  const sb = prepared();
  try {
    sb.stageAll();
    sb.apply();
    const r = sb.restore();
    assert.equal(r.kv.restored_keys, KEYS.join(','));
    assert.equal(readFileSync(join(sb.txnPath(), 'meta'), 'utf8').includes(FAKE.bot), false);
  } finally { sb.cleanup(); }
});
