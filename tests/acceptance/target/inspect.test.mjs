import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { FAKE, STUB, TXN, pinnedHermesVersion, sandbox } from './helpers/sandbox.mjs';

function populated(sb) {
  sb.write('.hermes/.env', `A=1\nTELEGRAM_BOT_TOKEN=${FAKE.bot}\nexport GITHUB_TOKEN=${FAKE.github}\n# comment\nlower=nope\n`, 0o640);
  sb.write('.hermes/config.yaml', 'model: x\n');
  sb.write('.hermes/skills/my-own-skill/SKILL.md', 'mine\n');
  sb.write('.hermes/cron.db', 'job-7\t0 1 * * *\tdo my own thing\n');
}

test('inspect is strictly read-only: whole-sandbox tree hash identical before and after', () => {
  const sb = sandbox();
  try {
    populated(sb);
    const before = sb.hash();
    const r = sb.run(['inspect']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(sb.hash(), before, 'inspect modified the sandbox');
    assert.equal(r.kv.op, 'inspect');
    assert.equal(r.kv.runtime_version, pinnedHermesVersion());
    assert.equal(r.kv.runtime_evidence, 'measured');
    assert.equal(r.kv.env_file, 'present');
    assert.equal(r.kv.env_perm, '640');
    assert.equal(r.kv.env_keys, 'A,GITHUB_TOKEN,TELEGRAM_BOT_TOKEN');
    assert.equal(r.kv.cron_other_count, '1');
    assert.equal(r.kv.cron_managed_ids, '');
    assert.equal(r.kv.skills_unmanaged, 'my-own-skill');
    assert.equal(r.kv.diagnostics, 'unknown');
    assert.match(r.kv.config_fingerprint, /^[0-9a-f]{16}$/);
    for (const v of Object.values(FAKE)) assert.ok(!r.stdout.includes(v) && !r.stderr.includes(v), 'secret value in output');
  } finally { sb.cleanup(); }
});

test('inspect creates nothing when ~/.hermes does not exist', () => {
  const sb = sandbox();
  try {
    const before = sb.hash();
    const r = sb.run(['inspect']);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(sb.hash(), before);
    assert.ok(!existsSync(sb.h), '.hermes was created by inspect');
    assert.equal(r.kv.env_file, 'absent');
    assert.equal(r.kv.env_perm, 'absent');
    assert.equal(r.kv.config_fingerprint, 'absent');
    assert.equal(r.kv.txn_incomplete, '');
  } finally { sb.cleanup(); }
});

test('inspect only ever runs `--version` and `cron list` on hermes (never doctor / --fix)', () => {
  const sb = sandbox();
  try {
    populated(sb);
    sb.run(['inspect']);
    const calls = sb.stubCalls();
    assert.ok(calls.length >= 1);
    for (const argv of calls) {
      const ok = (argv.length === 1 && argv[0] === '--version') || (argv.length === 2 && argv[0] === 'cron' && argv[1] === 'list');
      assert.ok(ok, `unexpected hermes call: ${argv.join(' ')}`);
    }
    const flat = calls.flat().join(' ');
    assert.ok(!/doctor|--fix/.test(flat));
  } finally { sb.cleanup(); }
});

test('missing hermes => runtime_version=unknown, evidence unknown, exit 0', () => {
  const sb = sandbox({ stub: false });
  try {
    populated(sb);
    const before = sb.hash();
    const r = sb.run(['inspect']);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.kv.hermes_present, '0');
    assert.equal(r.kv.runtime_version, 'unknown');
    assert.equal(r.kv.runtime_evidence, 'unknown');
    assert.equal(r.kv.cron_managed_ids, 'unknown');
    assert.equal(r.kv.cron_other_count, 'unknown');
    assert.equal(sb.hash(), before);
  } finally { sb.cleanup(); }
});

test('unparseable or failing `--version` => unknown (never a guess)', () => {
  const sb = sandbox();
  try {
    for (const env of [{ HSTACK_STUB_VERSION: 'banana' }, { HSTACK_STUB_VERSION: 'v-one', HSTACK_STUB_FAIL: 'version' }, { HSTACK_STUB_FAIL: 'version' }]) {
      const r = sb.run(['inspect'], { env });
      assert.equal(r.status, 0);
      assert.equal(r.kv.runtime_version, 'unknown', JSON.stringify(env));
      assert.equal(r.kv.runtime_evidence, 'unknown');
    }
  } finally { sb.cleanup(); }
});

test('a wrong version is reported verbatim; judging it is the JS caller job', () => {
  const sb = sandbox();
  try {
    const r = sb.run(['inspect'], { env: { HSTACK_STUB_VERSION: '0.14.9' } });
    assert.equal(r.status, 0);
    assert.equal(r.kv.runtime_version, '0.14.9');
    assert.equal(r.kv.runtime_evidence, 'measured');
  } finally { sb.cleanup(); }
});

test('inspect reports managed cron ids, incomplete txns and rejects arguments', () => {
  const sb = sandbox();
  try {
    sb.write('.hermes/cron.db', 'job-1\t0 9 * * *\t[hstack:founder-brief] brief\njob-2\t5 5 * * *\tmine\n');
    sb.write('.hermes/.env', 'A=1\n');
    assert.equal(sb.backup().status, 0);
    const r = sb.run(['inspect']);
    assert.equal(r.kv.cron_managed_ids, 'founder-brief');
    assert.equal(r.kv.cron_other_count, '1');
    assert.equal(r.kv.txn_incomplete, TXN);
    assert.equal(sb.run(['inspect', 'extra']).status, 2);
  } finally { sb.cleanup(); }
});

test('stub test double refuses doctor / --fix / unknown subcommands with exit 99 and touches nothing', () => {
  const sb = sandbox();
  try {
    sb.write('.hermes/.env', 'A=1\n');
    const before = sb.hash();
    for (const argv of [['doctor'], ['doctor', '--fix'], ['--fix'], ['cron', 'bogus'], ['gateway', 'restart'], ['totally-unknown'], []]) {
      const r = spawnSync('env', ['-i', `HOME=${sb.home}`, 'PATH=/usr/bin:/bin', 'bash', STUB, ...argv], { encoding: 'utf8' });
      assert.equal(r.status, 99, `argv=${argv.join(' ')}`);
    }
    assert.equal(sb.hash(), before);
  } finally { sb.cleanup(); }
});
