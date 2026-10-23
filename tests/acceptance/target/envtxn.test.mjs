import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALLOW, FAKE, KEYS, TXN, TXN2, filesContaining, modeOf, sandbox, sha256 } from './helpers/sandbox.mjs';

test('upsert: duplicates collapse to one, unrelated lines verbatim, lookalike keys untouched, no-trailing-newline last line', () => {
  const sb = sandbox();
  try {
    const original = [
      'A=1',
      `TELEGRAM_BOT_TOKEN=${FAKE.botOld}`,
      '# keep me   with  spaces',
      'TELEGRAM_BOT_TOKENX=lookalike-suffix',
      'XTELEGRAM_BOT_TOKEN=lookalike-prefix',
      'TELEGRAM.BOT_TOKEN=regex-dot',
      'TELEGRAM_BOT_TOKEN_OLD=lookalike-old',
      '',
      `export TELEGRAM_BOT_TOKEN=${FAKE.botOld}2`,
      'ZLAST=no-newline-at-end',
    ].join('\n'); // deliberately NO trailing newline: the `echo >>` merge bug
    sb.write('.hermes/.env', original, 0o600);
    assert.equal(sb.backup().status, 0);
    assert.equal(sb.put('TELEGRAM_BOT_TOKEN', FAKE.bot).status, 0);
    assert.equal(sb.put('GITHUB_TOKEN', FAKE.github).status, 0);
    const staged = readFileSync(join(sb.txnPath(), 'env.staged'), 'utf8');
    const expected = [
      'A=1',
      `TELEGRAM_BOT_TOKEN=${FAKE.bot}`,
      '# keep me   with  spaces',
      'TELEGRAM_BOT_TOKENX=lookalike-suffix',
      'XTELEGRAM_BOT_TOKEN=lookalike-prefix',
      'TELEGRAM.BOT_TOKEN=regex-dot',
      'TELEGRAM_BOT_TOKEN_OLD=lookalike-old',
      '',
      'ZLAST=no-newline-at-end',
      `GITHUB_TOKEN=${FAKE.github}`,
      '',
    ].join('\n');
    assert.equal(staged, expected);
    // the live file is not touched by staging
    assert.equal(sb.env(), original);
    // after apply the ZLAST line and the new key are on separate lines
    assert.equal(sb.stageCheck().status, 0);
    assert.equal(sb.apply().status, 0);
    assert.equal(sb.env(), expected);
  } finally { sb.cleanup(); }
});

test('modes: applied credentials are private; backups/staging are 600 and rollback restores the prior mode', () => {
  for (const [initial, wanted] of [[0o644, '600'], [0o640, '600'], [null, '600']]) {
    const sb = sandbox();
    try {
      // The 640 case already has the requested bytes: permissions must still be secured.
      const original = initial === 0o640
        ? `A=1\nGITHUB_TOKEN=${FAKE.github}\nTELEGRAM_BOT_TOKEN=${FAKE.bot}\nTELEGRAM_ALLOWED_USERS=${FAKE.allowed}\nTELEGRAM_HOME_CHANNEL=${FAKE.chat}\n`
        : 'A=1\n';
      if (initial !== null) sb.write('.hermes/.env', original, initial);
      sb.stageAll();
      assert.equal(modeOf(join(sb.txnPath(), 'env.staged')), '600');
      if (initial !== null) assert.equal(modeOf(join(sb.txnPath(), 'env.bak')), '600');
      assert.equal(sb.apply().status, 0);
      assert.equal(modeOf(sb.envPath), wanted);
      assert.equal(sb.restore().status, 0);
      if (initial !== null) {
        assert.equal(modeOf(sb.envPath), initial.toString(8));
        assert.equal(sb.env(), original);
      } else assert.equal(existsSync(sb.envPath), false);
    } finally { sb.cleanup(); }
  }
});

test('a secret value never reaches stdout/stderr/stub log or any file except .env, env.bak, env.staged (all private)', () => {
  const sb = sandbox();
  try {
    sb.write('.hermes/.env', `A=1\nTELEGRAM_BOT_TOKEN=${FAKE.botOld}\n`, 0o640);
    sb.write('.hermes/config.yaml', 'model: some-model\n');
    const outputs = [];
    const run = (r) => { outputs.push(r.stdout, r.stderr); return r; };
    run(sb.backup());
    for (const k of KEYS) {
      const v = { GITHUB_TOKEN: FAKE.github, TELEGRAM_BOT_TOKEN: FAKE.bot, TELEGRAM_ALLOWED_USERS: FAKE.allowed, TELEGRAM_HOME_CHANNEL: FAKE.chat }[k];
      run(sb.put(k, v));
    }
    run(sb.stageCheck());
    for (const v of [FAKE.github, FAKE.bot]) assert.ok(filesContaining(sb.txnPath(), v).includes('env.staged'), 'staged before apply');
    run(sb.apply(TXN, ['founder-brief|0 9 * * *|Send the founder brief']));
    run(sb.run(['reload', TXN]));
    run(sb.verify());
    run(sb.commit());
    const all = outputs.join('\n');
    for (const [name, v] of Object.entries(FAKE)) assert.ok(!all.includes(v), `${name} leaked into script output`);
    const logText = sb.stubCalls().flat().join('\n');
    for (const [name, v] of Object.entries(FAKE)) assert.ok(!logText.includes(v), `${name} leaked into hermes argv`);
    // env.staged (NEW secrets) is deleted as soon as apply succeeds: new values live only in the live .env
    for (const [name, v] of Object.entries(FAKE)) {
      const hits = filesContaining(sb.root, v).filter((h) => h !== 'stub.log');
      if (name === 'botOld') assert.deepEqual(hits, ['home/.hermes/.hstack/txn/' + TXN + '/env.bak']);
      else assert.deepEqual(hits, ['home/.hermes/.env'], name);
    }
    assert.equal(modeOf(join(sb.txnPath(), 'env.bak')), '600');
    assert.ok(!existsSync(join(sb.txnPath(), 'env.staged')));
    assert.equal(modeOf(sb.envPath), '600');
    // txn dir and state dir are private
    assert.equal(modeOf(sb.txnPath()), '700');
    assert.equal(modeOf(sb.statePath), '700');
  } finally { sb.cleanup(); }
});

test('stage-check fails (key NAMES only) when a staged secret value appears in config.yaml; short values are exempt', () => {
  const sb = sandbox();
  try {
    sb.write('.hermes/config.yaml', `telegram:\n  token: ${FAKE.bot}\n  short: ab12\n`);
    sb.write('.hermes/.env', 'A=1\n');
    sb.backup();
    sb.put('TELEGRAM_BOT_TOKEN', FAKE.bot);
    const r = sb.stageCheck();
    assert.equal(r.status, 1);
    assert.equal(r.kv.error, 'stage_check_failed');
    assert.equal(r.kv.detail, 'secret_value_in_config_yaml:TELEGRAM_BOT_TOKEN');
    assert.ok(!r.stdout.includes(FAKE.bot) && !r.stderr.includes(FAKE.bot));
    assert.equal(r.kv.stage_ok, undefined);
    // apply refuses too (it re-runs the stage check before touching anything)
    const before = sb.hash();
    const a = sb.apply();
    assert.equal(a.status, 1);
    assert.equal(sb.hash(), before);
  } finally { sb.cleanup(); }
  const sb2 = sandbox();
  try {
    sb2.write('.hermes/config.yaml', 'flag: ab12\n');
    sb2.backup();
    sb2.put('GITHUB_TOKEN', 'ab12');
    assert.equal(sb2.stageCheck().status, 0);
  } finally { sb2.cleanup(); }
});

test('stage-check fails when nothing is staged or the staged copy is not mode 600', () => {
  const sb = sandbox();
  try {
    sb.backup();
    assert.equal(sb.stageCheck().kv.detail, 'nothing_staged');
    sb.put('GITHUB_TOKEN', FAKE.github);
    chmodSync(join(sb.txnPath(), 'env.staged'), 0o644);
    const r = sb.stageCheck();
    assert.equal(r.status, 1);
    assert.equal(r.kv.detail, 'staged_env_mode_not_600');
  } finally { sb.cleanup(); }
});

test('put-env refuses bad values without echoing them and without touching the staged copy', () => {
  const sb = sandbox();
  try {
    sb.write('.hermes/.env', 'A=1\n');
    sb.backup();
    sb.put('GITHUB_TOKEN', FAKE.github);
    const bad = [
      'has space', 'q"uote', "q'uote", '$(touch /tmp/pwn)', '`id`', 'semi;colon', 'back\\slash', 'a|b', 'a&b', 'a<b',
      'x'.repeat(4097), '', 'line1\nline2', '\n', 'a\u0000b', 'café', 'tab\tinside',
    ];
    for (const v of bad) {
      const r = sb.run(['put-env', TXN, 'TELEGRAM_BOT_TOKEN', '--allow', ALLOW], { input: v.endsWith('\n') ? v : v + '\n' });
      assert.equal(r.status, 2, JSON.stringify(v).slice(0, 40));
      assert.equal(r.kv.error, 'value_invalid');
      if (v.length >= 6) assert.ok(!r.stdout.includes(v.trim()) && !r.stderr.includes(v.trim()));
    }
    // binary / no-newline inputs
    assert.equal(sb.run(['put-env', TXN, 'TELEGRAM_BOT_TOKEN', '--allow', ALLOW], { input: 'ok.value:1' }).status, 0, 'no trailing newline is fine');
    assert.equal(sb.run(['put-env', TXN, 'TELEGRAM_BOT_TOKEN', '--allow', ALLOW], { input: Buffer.from([0x61, 0x00, 0x62, 0x0a]) }).status, 2);
    assert.equal(sb.run(['put-env', TXN, 'GITHUB_TOKEN', '--allow', ALLOW], { input: FAKE.github + '\n' }).status, 0);
    assert.equal(readFileSync(join(sb.txnPath(), 'env.staged'), 'utf8'), `A=1\nGITHUB_TOKEN=${FAKE.github}\nTELEGRAM_BOT_TOKEN=ok.value:1\n`);
    assert.equal(sb.env(), 'A=1\n');
    assert.deepEqual(readFileSync(join(sb.txnPath(), 'staged.keys'), 'utf8').trim().split('\n'), ['GITHUB_TOKEN', 'TELEGRAM_BOT_TOKEN']);
  } finally { sb.cleanup(); }
});

test('put-env: key must be allowed AND managed by the txn, and staging closes once apply starts', () => {
  const sb = sandbox();
  try {
    assert.equal(sb.backup(TXN, 'GITHUB_TOKEN,TELEGRAM_BOT_TOKEN').status, 0);
    assert.equal(sb.run(['put-env', TXN, 'TELEGRAM_HOME_CHANNEL', '--allow', ALLOW], { input: '1\n' }).status, 2, 'not in txn keys');
    assert.equal(sb.run(['put-env', TXN, 'GITHUB_TOKEN', '--allow', 'TELEGRAM_BOT_TOKEN'], { input: 'v\n' }).status, 2, 'not in --allow');
    assert.equal(sb.run(['put-env', TXN, 'GITHUB_TOKEN'], { input: 'v\n' }).status, 2, '--allow required');
    assert.equal(sb.put('GITHUB_TOKEN', FAKE.github, TXN, 'GITHUB_TOKEN,TELEGRAM_BOT_TOKEN').status, 0);
    assert.equal(sb.apply().status, 0);
    const late = sb.put('GITHUB_TOKEN', FAKE.github, TXN, 'GITHUB_TOKEN,TELEGRAM_BOT_TOKEN');
    assert.equal(late.status, 3);
    assert.equal(late.kv.error, 'staging_closed');
  } finally { sb.cleanup(); }
});

test('apply refuses (exit 3, nothing changed) when .env, config.yaml changed after backup', () => {
  for (const [what, edit] of [
    ['env', (sb) => writeFileSync(sb.envPath, 'A=changed\n')],
    ['config', (sb) => writeFileSync(sb.cfgPath, 'model: changed\n')],
  ]) {
    const sb = sandbox();
    try {
      sb.write('.hermes/.env', 'A=1\n', 0o600);
      sb.write('.hermes/config.yaml', 'model: x\n');
      sb.stageAll();
      edit(sb);
      const before = sb.hash();
      const r = sb.apply(TXN, ['founder-brief|0 9 * * *|Send the founder brief']);
      assert.equal(r.status, 3, what);
      assert.equal(r.kv.error, 'changed_since_backup');
      assert.equal(r.kv.conflict, what);
      assert.equal(sb.hash(), before, 'apply changed something despite the conflict');
      assert.equal(sb.exists('.hermes/.hstack/txn/' + TXN + '/applying'), false);
    } finally { sb.cleanup(); }
  }
});

test('backup validates its environment: symlinked .env, missing hermes and incomplete txns all block (exit 4)', () => {
  const sb = sandbox();
  try {
    sb.write('.hermes/real-env', 'A=1\n');
    symlinkSync(join(sb.h, 'real-env'), sb.envPath);
    const before = sb.hash();
    const r = sb.backup();
    assert.equal(r.status, 4);
    assert.equal(r.kv.error, 'env_not_regular_file');
    assert.equal(sb.hash(), before);
  } finally { sb.cleanup(); }
  const nohermes = sandbox({ stub: false });
  try {
    const before = nohermes.hash();
    const r = nohermes.backup();
    assert.equal(r.status, 4);
    assert.equal(r.kv.error, 'runtime_unavailable');
    assert.equal(nohermes.hash(), before, 'a blocked backup must create nothing');
  } finally { nohermes.cleanup(); }
  const sb3 = sandbox();
  try {
    assert.equal(sb3.backup().status, 0);
    const second = sb3.backup(TXN2);
    assert.equal(second.status, 4);
    assert.equal(second.kv.error, 'incomplete_transaction');
    assert.equal(second.kv.detail, TXN);
    assert.equal(sb3.exists('.hermes/.hstack/txn/' + TXN2), false);
    assert.equal(sb3.backup(TXN).status, 4, 'reusing the id of an incomplete txn is also blocked');
  } finally { sb3.cleanup(); }
});

test('after commit or restore a new txn may start; a finished txn id cannot be reused', () => {
  const sb = sandbox();
  try {
    sb.stageAll();
    assert.equal(sb.apply().status, 0);
    assert.equal(sb.backup(TXN2).status, 4, 'applied but not committed still blocks');
    assert.equal(sb.commit().status, 0);
    assert.equal(sb.backup(TXN).kv.error, 'txn_exists');
    assert.equal(sb.backup(TXN2).status, 0);
    assert.equal(sb.restore(TXN2).status, 0);
    assert.equal(sb.backup('qqqq1111wwww').status, 0);
  } finally { sb.cleanup(); }
});

test('config.yaml is never modified by the transaction (apply, restore)', () => {
  const sb = sandbox();
  try {
    sb.write('.hermes/config.yaml', 'model: some-model\nkeep: me\n', 0o644);
    sb.stageAll();
    const cfg = sha256(readFileSync(sb.cfgPath));
    assert.equal(sb.apply().status, 0);
    assert.equal(sha256(readFileSync(sb.cfgPath)), cfg);
    assert.equal(sb.restore().status, 0);
    assert.equal(sha256(readFileSync(sb.cfgPath)), cfg);
    assert.equal(modeOf(sb.cfgPath), '644');
  } finally { sb.cleanup(); }
});

test('Telegram access overrides are rejected in staging and before the live credential swap', () => {
  for (const setting of ['GATEWAY_ALLOW_ALL_USERS=true', '  export GATEWAY_ALLOW_ALL_USERS = "true"', 'TELEGRAM_ALLOW_ALL_USERS=yes', 'TELEGRAM_GROUP_ALLOWED_CHATS=-100123']) {
    const sb = sandbox();
    try {
      const prior = `A=1\n${setting}\n`;
      sb.write('.hermes/.env', prior, 0o600);
      assert.equal(sb.backup().status, 0);
      for (const [key, value] of Object.entries({ GITHUB_TOKEN: FAKE.github, TELEGRAM_BOT_TOKEN: FAKE.bot, TELEGRAM_ALLOWED_USERS: FAKE.allowed, TELEGRAM_HOME_CHANNEL: FAKE.chat })) {
        assert.equal(sb.put(key, value).status, 0);
      }
      const staged = sb.stageCheck();
      assert.equal(staged.status, 1, setting);
      assert.match(staged.kv.detail, /^(open_access_switch:|group_wide_access_enabled)/);
      const applied = sb.apply();
      assert.equal(applied.status, 1, setting);
      assert.equal(sb.env(), prior, 'no new credential is written before the access policy passes');
    } finally { sb.cleanup(); }
  }
});
