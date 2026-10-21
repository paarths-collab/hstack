import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALLOW, CRON_SPEC, FAKE, TXN, sandbox } from './helpers/sandbox.mjs';

const HOSTILE_TXN = [
  '', 'short', 'UPPERCASE123', '../etc/passwd1', 'abc;rm -rf 12345678', 'abcd1234$(id)', 'abcd1234`id`ab', 'abcd efgh1234',
  'abcdefgh\n12345678', '12345678\nabcdefgh', 'abcdefgh12345678abcdefgh1234567890', 'a'.repeat(33), 'abcd-efgh-1234', 'abcd.efgh.1234',
  '..', '.', '/abs/olute1', 'abcd1234\t', '*********', 'abcd123*', "abcd'1234", 'abcd"1234',
];

test('hostile transaction ids are rejected (exit 2) by every op, touching nothing and never reaching hermes', () => {
  const sb = sandbox();
  try {
    sb.write('.hermes/.env', 'A=1\n', 0o600);
    sb.write('.hermes/skills/mine/SKILL.md', 'x\n');
    sb.write('.hermes/cron.db', 'job-1\t1 1 * * *\tmine\n');
    const before = sb.hash();
    const ops = (t) => [
      ['backup', t, '--keys', 'GITHUB_TOKEN'],
      ['put-env', t, 'GITHUB_TOKEN', '--allow', 'GITHUB_TOKEN'],
      ['stage-check', t],
      ['skills-sync', t, '--names', 'alpha-skill'],
      ['apply', t],
      ['apply', t, '--cron', CRON_SPEC],
      ['reload', t],
      ['verify', t, '--destination-fp', '0123456789abcdef', '--allow-var', 'TELEGRAM_ALLOWED_USERS', '--dest-var', 'TELEGRAM_HOME_CHANNEL', '--cron-id', 'founder-brief', '--schedule', '0 9 * * *'],
      ['restore', t],
      ['commit', t],
      ['purge', t],
    ];
    for (const t of HOSTILE_TXN) {
      for (const args of ops(t)) {
        const r = sb.run(args, { input: 'value\n' });
        assert.equal(r.status, 2, `${args[0]} ${JSON.stringify(t)} => ${r.status} ${r.stdout}`);
        assert.equal(r.kv.error, 'usage');
      }
    }
    assert.equal(sb.hash(), before);
    assert.deepEqual(sb.stubCalls(), [], 'validation must happen before any hermes call');
  } finally { sb.cleanup(); }
});

test('hostile env keys: bad charset, glob/regex characters, duplicates, keys outside --allow are rejected (exit 2), nothing touched', () => {
  const sb = sandbox();
  try {
    sb.write('.hermes/.env', 'A=1\n', 0o600);
    const before = sb.hash();
    const bad = ['lower', 'A B', 'A.*', 'A;B', 'A\nB', 'A*', 'TELEGRAM_*', 'A$', '^A', 'A[B]', '1ABC', '_ABC', 'A-B', '$(id)', '', 'A,B,A', 'A,,B', ',A', 'A,', 'A?', '../A', 'é'];
    for (const k of bad) {
      assert.equal(sb.run(['backup', TXN, '--keys', k]).status, 2, 'backup --keys ' + JSON.stringify(k));
    }
    assert.equal(sb.run(['backup', TXN]).status, 2, '--keys is required');
    assert.equal(sb.run(['backup', TXN, '--keys']).status, 2);
    assert.equal(sb.run(['backup', TXN, '--keys', 'GITHUB_TOKEN', '--allow', 'TELEGRAM_BOT_TOKEN']).status, 2, 'key outside --allow');
    assert.equal(sb.run(['backup', TXN, '--keys', 'GITHUB_TOKEN', '--surprise', 'x']).status, 2);
    assert.equal(sb.hash(), before);
    assert.equal(sb.backup().status, 0);
    const mid = sb.hash();
    for (const k of bad.filter((x) => x !== 'A,B,A')) {
      const r = sb.run(['put-env', TXN, k, '--allow', ALLOW], { input: 'v\n' });
      assert.equal(r.status, 2, 'put-env key ' + JSON.stringify(k));
    }
    for (const allow of ['', 'lower', 'A.*', 'GITHUB_TOKEN,GITHUB_TOKEN']) {
      assert.equal(sb.run(['put-env', TXN, 'GITHUB_TOKEN', '--allow', allow], { input: 'v\n' }).status, 2, 'allow ' + JSON.stringify(allow));
    }
    assert.equal(sb.hash(), mid);
  } finally { sb.cleanup(); }
});

test('glob and regex characters in a key can never match other keys (literal compare in awk)', () => {
  const sb = sandbox();
  try {
    // keys are rigidly validated, so the only way a "pattern" could matter is through look-alike names
    const lines = ['GITHUB_TOKENS=a', 'GITHUB_TOKEN2=b', 'XGITHUB_TOKEN=c', 'GITHUB_TOKE=d', 'GITHUB.TOKEN=e', 'GITHUB_TOKEN_=f', 'GITHUB_TOKEN =g', 'github_token=h'];
    sb.write('.hermes/.env', lines.join('\n') + '\nGITHUB_TOKEN=old-value-1\n', 0o600);
    sb.backup(TXN, 'GITHUB_TOKEN');
    assert.equal(sb.put('GITHUB_TOKEN', FAKE.github, TXN, 'GITHUB_TOKEN').status, 0);
    assert.equal(readFileSync(join(sb.txnPath(), 'env.staged'), 'utf8'), lines.join('\n') + `\nGITHUB_TOKEN=${FAKE.github}\n`);
    assert.equal(sb.stageCheck().status, 0);
    assert.equal(sb.apply().status, 0);
    assert.equal(sb.restore().status, 0);
    assert.equal(sb.env(), lines.join('\n') + '\nGITHUB_TOKEN=old-value-1\n');
  } finally { sb.cleanup(); }
});

test('verify arguments are validated: fingerprint, variable names, cron id, schedule', () => {
  const sb = sandbox();
  try {
    sb.backup();
    sb.put('GITHUB_TOKEN', FAKE.github);
    sb.apply();
    const good = { fp: '0123456789abcdef', allowVar: 'TELEGRAM_ALLOWED_USERS', destVar: 'TELEGRAM_HOME_CHANNEL', cronId: 'founder-brief', schedule: '0 9 * * *' };
    const bads = [
      { fp: '0123456789ABCDEF' }, { fp: '0123' }, { fp: '0123456789abcdeg' }, { fp: '0123456789abcdef0' }, { fp: '../../../etc/pass' },
      { allowVar: 'lower' }, { allowVar: 'A;B' }, { allowVar: '' }, { destVar: 'A B' }, { destVar: '$(id)' },
      { cronId: 'A' }, { cronId: 'a b' }, { cronId: 'a;b' }, { cronId: '' }, { cronId: '../x' },
      { schedule: '0 9 * * *; id' }, { schedule: '-1 * * * *' }, { schedule: 'abc' }, { schedule: '' }, { schedule: '$(id)' },
    ];
    const before = sb.hash();
    for (const over of bads) {
      const r = sb.verify({ ...good, ...over });
      assert.equal(r.status, 2, JSON.stringify(over));
    }
    assert.equal(sb.run(['verify', TXN, '--destination-fp', good.fp]).status, 2, 'missing options');
    assert.equal(sb.run(['verify', TXN, '--bogus', 'x']).status, 2);
    assert.equal(sb.run(['verify', TXN, '--destination-fp']).status, 2);
    assert.equal(sb.hash(), before);
  } finally { sb.cleanup(); }
});

test('unknown ops, missing ops and extra arguments are usage errors; relative or hostile HSTACK_HOME is refused', () => {
  const sb = sandbox();
  try {
    sb.write('.hermes/.env', 'A=1\n');
    const before = sb.hash();
    for (const args of [[], ['frobnicate'], ['restore'], ['restore', TXN, 'extra'], ['commit'], ['purge', TXN, 'x'], ['reload'], ['stage-check'], ['apply'], ['put-env', TXN], ['inspect', '--x'], ['--help'], ['INSPECT']]) {
      assert.equal(sb.run(args).status, 2, JSON.stringify(args));
    }
    for (const home of ['relative/dir', '/tmp/a\\b', '/tmp/../etc', '/tmp/a\nb']) {
      const r = sb.run(['inspect'], { env: { HSTACK_HOME: home } });
      assert.equal(r.status, 2, JSON.stringify(home));
    }
    assert.equal(sb.hash(), before);
  } finally { sb.cleanup(); }
});

test('HSTACK_HOME is honoured over HOME (all state lives under it)', () => {
  const sb = sandbox();
  const other = sandbox();
  try {
    other.write('.hermes/.env', 'ONLY_HERE=1\n');
    const r = sb.run(['inspect'], { env: { HSTACK_HOME: other.home } });
    assert.equal(r.kv.env_keys, 'ONLY_HERE');
  } finally { sb.cleanup(); other.cleanup(); }
});
