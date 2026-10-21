import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { CRON_SPEC, TXN, TXN2, sandbox } from './helpers/sandbox.mjs';

const MARK = '[hstack:founder-brief]';
const marked = (sb) => sb.cron().split('\n').filter((l) => l.includes(MARK));
const UNRELATED = [
  'job-1\t30 2 * * *\tbackup my laptop',
  'job-2\t0 9 * * *\tmentions hstack:founder-brief without brackets',
  'job-3\t0 9 * * *\t[hstack:founder] a different managed id that is not ours',
].join('\n') + '\n';

function seeded() {
  const sb = sandbox();
  sb.write('.hermes/.env', 'A=1\n', 0o600);
  sb.write('.hermes/cron.db', UNRELATED);
  sb.write('.hermes/cron.seq', '3\n');
  return sb;
}

test('apply twice (same txn) => exactly one marked entry; unrelated entries byte-identical', () => {
  const sb = seeded();
  try {
    sb.stageAll();
    const first = sb.apply(TXN, [CRON_SPEC]);
    assert.equal(first.status, 0, first.stdout);
    assert.equal(first.kv['cron_founder-brief'], 'created');
    const second = sb.apply(TXN, [CRON_SPEC]);
    assert.equal(second.status, 0, second.stdout);
    assert.equal(second.kv['cron_founder-brief'], 'unchanged');
    assert.equal(marked(sb).length, 1);
    assert.ok(sb.cron().startsWith(UNRELATED), 'unrelated entries must stay exactly as they were');
    const [id, sched, prompt] = marked(sb)[0].split('\t');
    assert.match(id, /^job-\d+$/);
    assert.equal(sched, '0 9 * * *');
    assert.ok(prompt.startsWith(MARK + ' '), 'marker is prefixed when the prompt lacks it');
  } finally { sb.cleanup(); }
});

test('a second txn with the same schedule after commit => unchanged, still exactly one entry', () => {
  const sb = seeded();
  try {
    sb.stageAll();
    sb.apply(TXN, [CRON_SPEC]);
    sb.commit();
    sb.stageAll(TXN2);
    const r = sb.apply(TXN2, [CRON_SPEC]);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.kv['cron_founder-brief'], 'unchanged');
    assert.equal(marked(sb).length, 1);
    // different schedule => replaced in place, never duplicated
    sb.commit(TXN2);
    sb.stageAll('qqqq1111wwww');
    const u = sb.apply('qqqq1111wwww', ['founder-brief|30 7 * * 1|Send the founder brief']);
    assert.equal(u.kv['cron_founder-brief'], 'updated');
    assert.equal(marked(sb).length, 1);
    assert.ok(marked(sb)[0].includes('30 7 * * 1'));
    assert.ok(sb.cron().startsWith(UNRELATED));
  } finally { sb.cleanup(); }
});

test('pre-existing duplicate marked entries collapse into one; unmarked lookalikes are never touched', () => {
  const sb = seeded();
  try {
    appendFileSync(sb.cronPath, `job-4\t0 8 * * *\t${MARK} old duplicate one\njob-5\t0 8 * * *\t${MARK} old duplicate two\n`);
    sb.stageAll();
    const r = sb.apply(TXN, [CRON_SPEC]);
    assert.equal(r.kv['cron_founder-brief'], 'updated');
    assert.equal(marked(sb).length, 1);
    assert.ok(sb.cron().startsWith(UNRELATED));
    // removing the managed entries never calls remove on unrelated job ids
    const removes = sb.stubCalls().filter((a) => a[0] === 'cron' && a[1] === 'remove').map((a) => a[2]);
    assert.deepEqual(removes.sort(), ['job-4', 'job-5']);
  } finally { sb.cleanup(); }
});

test('restore removes our entry and re-creates the one it replaced; unrelated entries stay', () => {
  const sb = seeded();
  try {
    appendFileSync(sb.cronPath, `job-4\t15 6 * * *\t${MARK} the earlier version of this entry\n`);
    sb.stageAll();
    sb.apply(TXN, [CRON_SPEC]);
    assert.ok(marked(sb)[0].includes('0 9 * * *'));
    const r = sb.restore();
    assert.equal(r.status, 0, r.stdout);
    assert.equal(marked(sb).length, 1);
    const [, sched, prompt] = marked(sb)[0].split('\t');
    assert.equal(sched, '15 6 * * *');
    assert.equal(prompt, `${MARK} the earlier version of this entry`);
    assert.ok(sb.cron().startsWith(UNRELATED));
  } finally { sb.cleanup(); }
  const sb2 = seeded();
  try {
    sb2.stageAll();
    sb2.apply(TXN, [CRON_SPEC]);
    assert.equal(sb2.restore().status, 0);
    assert.equal(marked(sb2).length, 0, 'created entry is removed');
    assert.equal(sb2.cron(), UNRELATED);
  } finally { sb2.cleanup(); }
});

test('a second incomplete transaction is blocked at backup (exit 4) and leaves no trace', () => {
  const sb = seeded();
  try {
    sb.stageAll();
    sb.apply(TXN, [CRON_SPEC]);
    const before = sb.hash();
    const r = sb.backup(TXN2);
    assert.equal(r.status, 4);
    assert.equal(r.kv.error, 'incomplete_transaction');
    assert.equal(r.kv.detail, TXN);
    assert.equal(sb.hash(), before);
    assert.equal(sb.run(['inspect']).kv.txn_incomplete, TXN);
  } finally { sb.cleanup(); }
});

test('invalid --cron specs exit 2 and touch nothing', () => {
  const sb = seeded();
  try {
    sb.stageAll();
    const before = sb.hash();
    const bad = [
      'founder-brief|0 9 * * *; rm -rf /|prompt',
      'founder-brief|$(id)|prompt',
      'founder-brief|-1 * * * *|prompt',
      'founder-brief|abc|prompt',
      'founder-brief| |prompt',
      'founder-brief|0 9 * * *|use $HOME and `id`',
      'founder-brief|0 9 * * *|new\nline',
      'founder-brief|0 9 * * *|tab\tinside',
      'founder-brief|0 9 * * *|--fix',
      'founder-brief|0 9 * * *|embeds [hstack:other] marker',
      'founder-brief|0 9 * * *|',
      '../evil|0 9 * * *|prompt',
      'Founder|0 9 * * *|prompt',
      'a b|0 9 * * *|prompt',
      'founder-brief;ls|0 9 * * *|prompt',
      'no-pipes-at-all',
      'only|one-pipe',
      '|0 9 * * *|prompt',
      `founder-brief|0 9 * * *|${'x'.repeat(1001)}`,
    ];
    for (const spec of bad) {
      const r = sb.run(['apply', TXN, '--cron', spec]);
      assert.equal(r.status, 2, JSON.stringify(spec));
      assert.equal(sb.hash(), before, JSON.stringify(spec));
    }
    const dup = sb.run(['apply', TXN, '--cron', CRON_SPEC, '--cron', CRON_SPEC]);
    assert.equal(dup.status, 2);
    assert.equal(sb.run(['apply', TXN, '--cron']).status, 2);
    assert.equal(sb.run(['apply', TXN, '--bogus']).status, 2);
    assert.equal(sb.hash(), before);
    assert.deepEqual(sb.stubCalls().filter((a) => a[0] === 'cron' && a[1] === 'create'), []);
  } finally { sb.cleanup(); }
});

test('hermes arguments for cron create carry the validated schedule and prompt verbatim (no shell involved)', () => {
  const sb = seeded();
  try {
    sb.stageAll();
    sb.apply(TXN, ['founder-brief|*/15 9-17 * * 1,2|Brief: summarize (read-only) 100% of #issues, ok?']);
    const create = sb.stubCalls().filter((a) => a[0] === 'cron' && a[1] === 'create');
    assert.equal(create.length, 1);
    assert.deepEqual(create[0].slice(2), ['*/15 9-17 * * 1,2', `${MARK} Brief: summarize (read-only) 100% of #issues, ok?`]);
  } finally { sb.cleanup(); }
});

test('a cron create failure after the env swap leaves the txn restorable and creates no partial entry', () => {
  const sb = seeded();
  try {
    sb.stageAll();
    const r = sb.run(['apply', TXN, '--cron', CRON_SPEC], { env: { HSTACK_STUB_FAIL: 'cron-create' } });
    assert.equal(r.status, 1);
    assert.equal(marked(sb).length, 0);
    assert.equal(sb.restore().status, 0);
    assert.equal(sb.cron(), UNRELATED);
    // a failing remove while replacing also stops with exit 1 and keeps the old entry
    sb.commit();
  } finally { sb.cleanup(); }
  const sb2 = seeded();
  try {
    appendFileSync(sb2.cronPath, `job-4\t15 6 * * *\t${MARK} earlier\n`);
    sb2.stageAll();
    const r = sb2.run(['apply', TXN, '--cron', CRON_SPEC], { env: { HSTACK_STUB_FAIL: 'cron-remove' } });
    assert.equal(r.status, 1);
    assert.equal(r.kv.error, 'cron_remove_failed');
    assert.equal(sb2.restore().status, 0, 'restore cleans up the duplicate created before the failed remove');
    assert.equal(marked(sb2).length, 1);
    assert.ok(marked(sb2)[0].includes('15 6 * * *'));
  } finally { sb2.cleanup(); }
});

test('cron state that cannot be read blocks apply/backup (exit 4) before any mutation', () => {
  const sb = seeded();
  try {
    sb.stageAll();
    const before = sb.hash();
    const r = sb.run(['apply', TXN, '--cron', CRON_SPEC], { env: { HSTACK_STUB_FAIL: 'cron-list' } });
    assert.equal(r.status, 4);
    assert.equal(r.kv.error, 'runtime_unavailable');
    assert.equal(sb.hash(), before);
    assert.equal(readFileSync(sb.cronPath, 'utf8'), UNRELATED);
    writeFileSync(sb.cronPath, UNRELATED);
  } finally { sb.cleanup(); }
});
